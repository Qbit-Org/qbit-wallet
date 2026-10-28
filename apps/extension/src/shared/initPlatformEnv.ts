import { PlatformEnv } from '@qbit/wallet-shared';

PlatformEnv.VERSION = process.env.release!;
PlatformEnv.CHANNEL = process.env.channel!;
PlatformEnv.PLATFORM = 'extension';
PlatformEnv.MANIFEST_VERSION = process.env.manifest!;
PlatformEnv.REVIEW_URL = 'https://qbit.org/extension/reviews';
PlatformEnv.CORE_RELEASE_TAG = process.env.coreReleaseTag!;
PlatformEnv.CORE_RELEASE_COMMIT = process.env.coreReleaseCommit!;

export const initPlatformEnv = async () => undefined;
