async function sleep(timeSec: number) {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve(null)
    }, timeSec * 1000)
  })
}

export const timeUtils = {
  sleep,
}
