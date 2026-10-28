const parseSenderUrl = (url: unknown): URL | null => {
  if (typeof url !== 'string' || !url) {
    return null
  }
  try {
    return new URL(url)
  } catch {
    return null
  }
}

const tabCheckin = ({
  data: {
    params: { name, icon },
  },
  session,
  port,
}) => {
  // Bind the request to the exact document that opened this Port. `tab.url`
  // can already point at a newer navigation while an older document's Port is
  // still alive, so it is not an origin authority for provider requests.
  const sender = port?.sender
  const senderUrl = parseSenderUrl(sender?.url)
  // `sender.origin` is the browser's security origin for that document, so it
  // is the authority. A CSP-sandboxed document keeps its host's URL but runs
  // with an opaque "null" origin; deriving the origin from the URL alone would
  // hand it the host origin's connected session and approvals.
  const trustedOrigin = sender?.origin

  // If we can't verify the origin, reject the request
  if (
    typeof trustedOrigin !== 'string' ||
    trustedOrigin === 'null' ||
    !senderUrl ||
    (senderUrl.protocol !== 'https:' && senderUrl.protocol !== 'http:') ||
    senderUrl.origin !== trustedOrigin
  ) {
    throw new Error('Cannot verify request origin')
  }

  // Use the verified trusted origin instead of trusting client-provided values
  session.setProp({
    origin: trustedOrigin,
    name: typeof name === 'string' ? name.slice(0, 256) : trustedOrigin,
    icon: typeof icon === 'string' ? icon.slice(0, 2048) : '',
  })
  return 'ACK_QBIT_PROVIDER_SESSION'
}

export default {
  tabCheckin,
}
