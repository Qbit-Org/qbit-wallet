# @qbit/permission-service

Cross-platform permission management service for web3 applications.

## Features

- **Cross-platform**: Works in browsers, Node.js, and browser extensions
- **Storage Adapters**: Flexible storage backend (memory, localStorage, extension storage)
- **LRU Cache**: Efficient permission caching with automatic cleanup
- **Type Safe**: Full TypeScript support
- **Site Management**: Pin, unpin, and organize connected sites

## Installation

This package is private to the qbit-wallet workspace and is not published to
npm. Other workspace packages depend on it as
`"@qbit/permission-service": "workspace:*"`.

Do not install `@qbit/permission-service` from a registry. This project does not
own the `@qbit` scope on npm (#289), so a package published there under this
name does not come from this repository.

## Quick Start

```typescript
import { PermissionService, MemoryStorageAdapter, ChainType } from '@qbit/permission-service';

// Create with memory storage
const permissionService = new PermissionService({
  storage: new MemoryStorageAdapter(),
  storageKey: 'permissions'
});

// Initialize
await permissionService.init();

// Add a connected site
await permissionService.addConnectedSite(
  'https://example.com',
  'Example DApp',
  'https://example.com/icon.png',
  ChainType.QBIT_TESTNET4
);

// Check permissions
const hasPermission = permissionService.hasPermission('https://example.com');
console.log(hasPermission); // true
```

## Storage Adapters

### Memory Storage
```typescript
import { MemoryStorageAdapter } from '@qbit/permission-service/adapters';

const storage = new MemoryStorageAdapter();
```

### LocalStorage (Browser)
```typescript
import { LocalStorageAdapter } from '@qbit/permission-service/adapters';

const storage = new LocalStorageAdapter();
```

### Extension Storage
```typescript
import { ExtensionPersistStoreAdapter } from '@qbit/permission-service/adapters';
import { createPersistStore } from '@/background/utils';

const storage = new ExtensionPersistStoreAdapter(createPersistStore, 'permissions');
```

## API Reference

### PermissionService

Main service class for managing permissions.

#### Methods

- `init()`: Initialize the service
- `addConnectedSite(origin, name, icon, chain)`: Add a connected site
- `hasPermission(origin)`: Check if origin has permission
- `getSite(origin)`: Get site information
- `getConnectedSites()`: Get all connected sites
- `removeConnectedSite(origin)`: Remove a connected site
- `topConnectedSite(origin)`: Pin site to top
- `unpinConnectedSite(origin)`: Unpin site

## License

MIT
