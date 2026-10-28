import createPqcModule from "./pqc.mjs";
import { createPqcClient } from "./pqc-wrapper.mjs";
import { runB1Suite } from "./pqc-suite.mjs";
import { vectors } from "./golden-vectors-data.mjs";

async function createClient() {
  return createPqcClient({
    createModule: createPqcModule,
    moduleOptions: {
      locateFile: (path) => chrome.runtime.getURL(path),
    },
  });
}

globalThis.__B1_HARNESS__ = {
  run(options = {}) {
    return runB1Suite({
      env: "chrome-mv3-service-worker",
      createClient,
      vectors,
      ...options,
    });
  },
};

globalThis.__B1_READY__ = true;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "b1-ping") {
    sendResponse({ ok: true });
  }
  return false;
});
