declare module '@qbit-oss/pqc/wasm/pqc.mjs' {
  import type { PqcWasmModuleFactory } from '@qbit-oss/pqc';

  const createPqcModule: PqcWasmModuleFactory;
  export default createPqcModule;
}
