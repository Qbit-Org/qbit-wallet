export function initKeepAlive() {
  // Chrome stops the MV3 service worker after 30 seconds without an event or
  // extension API call; opening and posting on this port every 5 seconds keeps
  // it running.
  const INTERNAL_STAYALIVE_PORT = 'CT_Internal_port_alive';
  let alivePort: any = null;

  setInterval(() => {
    if (alivePort == null) {
      alivePort = chrome.runtime.connect({ name: INTERNAL_STAYALIVE_PORT });
      alivePort.onDisconnect.addListener(() => {
        if (chrome.runtime.lastError) {
          // console.error('Keep-alive port disconnected:', chrome.runtime.lastError);
        }
        alivePort = null;
      });
    }

    if (alivePort) {
      alivePort.postMessage({ content: 'keep alive' });
    }
  }, 5000);
}
