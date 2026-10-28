import YAML from 'yaml'

// GitHub only runs the YAML files directly inside .github/workflows.
export const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/
// Owner and repository names are case-insensitive in a `uses` reference.
const CHECKOUT_ACTION = /^actions\/checkout@/i

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function permissionsErrors(location, permissions) {
  if (isMapping(permissions) || permissions === 'read-all') return []
  if (permissions === 'write-all') {
    return [`${location}: permissions: write-all grants every scope; list only the scopes it needs`]
  }
  return [
    `${location}: permissions must be a mapping of scopes or read-all, found ${JSON.stringify(permissions)}`,
  ]
}

// With persist-credentials left on (the default), actions/checkout writes its
// credential into .git/config (or core.sshCommand), where every later step,
// including dependency install scripts, can read it. That credential is the
// job's github.token unless `token` or `ssh-key` supplies another one, so every
// checkout must turn persisting off, whatever it was given.
// Actions inputs are strings, so YAML `false` and a quoted "false" are the same.
function persistsCredentials(inputs) {
  const value = inputs['persist-credentials']
  return !(value === false || (typeof value === 'string' && value.trim().toLowerCase() === 'false'))
}

// A job without a `permissions` key, in a workflow without one, gets the
// repository's default GITHUB_TOKEN permissions, which can be write to every
// scope. Each workflow must therefore declare its token scope at the top level
// or on every job, so the repository default never applies.
export function auditWorkflowPermissions(workflowFiles) {
  const errors = []
  let workflowCount = 0
  let checkoutCount = 0
  for (const { file, source } of workflowFiles) {
    workflowCount += 1
    let workflow
    try {
      workflow = YAML.parse(source)
    } catch (error) {
      errors.push(`${file}: workflow YAML cannot be parsed: ${error.message.split('\n')[0]}`)
      continue
    }
    if (
      !isMapping(workflow) ||
      !isMapping(workflow.jobs) ||
      Object.keys(workflow.jobs).length === 0
    ) {
      errors.push(`${file}: workflow must declare a non-empty jobs mapping`)
      continue
    }

    const workflowDeclaresPermissions = Object.hasOwn(workflow, 'permissions')
    if (workflowDeclaresPermissions) {
      errors.push(...permissionsErrors(file, workflow.permissions))
    }
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      const location = `${file}: job ${jobId}`
      if (!isMapping(job)) {
        errors.push(`${location} must be a mapping`)
        continue
      }
      if (Object.hasOwn(job, 'permissions')) {
        errors.push(...permissionsErrors(location, job.permissions))
      } else if (!workflowDeclaresPermissions) {
        errors.push(
          `${location} declares no permissions and neither does the workflow, so its GITHUB_TOKEN gets the repository default`
        )
      }

      const steps = job.steps ?? []
      if (!Array.isArray(steps)) {
        errors.push(`${location}: steps must be a list`)
        continue
      }
      steps.forEach((step, index) => {
        if (!isMapping(step) || typeof step.uses !== 'string' || !CHECKOUT_ACTION.test(step.uses)) {
          return
        }
        checkoutCount += 1
        const inputs = isMapping(step.with) ? step.with : {}
        if (persistsCredentials(inputs)) {
          const stepName = typeof step.name === 'string' ? step.name : `step ${index + 1}`
          errors.push(
            `${location}, ${stepName}: actions/checkout must set persist-credentials: false so its credentials are not left in .git/config`
          )
        }
      })
    }
  }
  return { checkoutCount, errors, workflowCount }
}
