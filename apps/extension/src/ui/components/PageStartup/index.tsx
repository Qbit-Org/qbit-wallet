import { LoaderCircle } from 'lucide-react';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import {
  accountActions,
  globalActions,
  keyringsActions,
  settingsActions,
  transactionsActions,
  uiActions,
  useAppDispatch,
  useIsReady,
  useIsUnlocked,
  useWallet
} from '@qbit/wallet-state';

import { noteWalletIdRead, recordShownWalletId, reconcileStoredWalletData } from '@/ui/utils/walletReset';

import { Content } from '../Content';
import { Icon } from '../Icon';
import { StartupErrorScreen } from '../StartupErrorScreen';

/**
 * The pauses before each new run of a page's start-up reads after one failed;
 * the page gives up once the run after the last pause fails too. A wallet
 * page's call that comes in while a reset, or the completion of one, clears
 * wallet data waits for it and is then refused ("Qbit Wallet was reset before
 * this request ran"), and that refusal ends with the completion: the run after
 * it can succeed. The pauses also cover other passing errors, such as a
 * connection to the background that dropped.
 */
export const PAGE_STARTUP_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000];

/**
 * The pauses before each new run of a started page whose id read failed for
 * its own reason, as when the first save of a new id fails, so that it holds
 * no id while the background recovers only for a short while; then no more.
 * Locks and unlocks start runs of their own meanwhile.
 */
export const PAGE_WALLET_ID_RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000, 30_000, 60_000, 120_000];

/**
 * Run `start` until a run succeeds: once, then again after each pause of
 * `delays` while it fails, and no more. 'started' once a run succeeded,
 * 'failed' once the run after the last pause failed, 'stopped' when
 * `stopped()`, asked at the end of each pause, says no more runs are wanted.
 */
async function startWithRetries(
  start: () => Promise<void>,
  { delays = PAGE_STARTUP_RETRY_DELAYS_MS, stopped }: { delays?: readonly number[]; stopped: () => boolean }
): Promise<'started' | 'failed' | 'stopped'> {
  for (let failures = 0; ; failures++) {
    try {
      await start();
      return 'started';
    } catch {
      if (failures >= delays.length) return 'failed';
    }
    await new Promise((resolve) => setTimeout(resolve, delays[failures]));
    if (stopped()) return 'stopped';
  }
}

type QuietSetting = 'skippedVersion' | 'autoLockTimeId' | 'developerMode';

/**
 * The wallet pages, once the page's start-up reads have loaded: the id of the
 * wallet set up, the current account, the settings, and whether a wallet is
 * set up and unlocked. A spinner until then. A run of the reads that fails,
 * refused or otherwise, is made again after short pauses (startWithRetries);
 * a page that still cannot start shows the start-up error screen rather than
 * a spinner for ever, whose Retry runs this page's start-up again; once that
 * has failed too, its Retry restarts the extension, as after a failure of the
 * background's start-up. A page that has started stays as it is when a later
 * run fails, and nothing here reloads it.
 *
 * The routine runs again whenever the lock state or isReady changes, its own
 * dispatches included; one run at a time: a change during a run asks for one
 * more after it, which reads again only what has not loaded.
 */
export function PageStartup({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const dispatch = useAppDispatch();

  const isReady = useIsReady();
  const isUnlocked = useIsUnlocked();
  // 'page': this page's start-up failed, and its Retry runs it again;
  // 'again': it failed again after that Retry, which now restarts.
  const [startFailed, setStartFailed] = useState<false | 'page' | 'again'>(false);

  const selfRef = useRef({
    settingsLoaded: false,
    accountLoaded: false,
    vaultLoaded: false,
    walletIdRecorded: false,
    // The last id read failed for its own reason (PAGE_WALLET_ID_RETRY_DELAYS_MS).
    walletIdReadFailed: false,
    // What the page showed was dropped as it recorded the id while locked:
    // its account and wallets are read again at the next unlock.
    walletsDropped: false,
    // The settings read without holding the page back: out, or read.
    quietReads: new Map<QuietSetting, 'reading' | 'read'>()
  });
  const self = selfRef.current;
  const init = useCallback(async () => {
    // Read without holding the page back, as they always were. One that is
    // out is not asked for again meanwhile, none counts as read before it is,
    // and a failed one keeps its default until the next run reads it again.
    const readQuietly = <T,>(setting: QuietSetting, read: () => Promise<T>, apply: (value: T) => void) => {
      if (self.quietReads.has(setting)) return;
      self.quietReads.set(setting, 'reading');
      Promise.resolve()
        .then(read)
        .then(apply)
        .then(
          () => {
            self.quietReads.set(setting, 'read');
          },
          () => {
            self.quietReads.delete(setting);
          }
        );
    };

    // A page that does not hold the id yet reads its account again in each
    // run, after the id, until it does; so does one that dropped what it
    // showed to record the id while locked, at its next unlocked run.
    const readAccount = !self.accountLoaded || !self.walletIdRecorded;
    const accountShownBefore = self.accountLoaded;

    const loadAccountAndSettings = async () => {
      if (readAccount) {
        const currentAccount = await wallet.getCurrentAccount();
        if (currentAccount) {
          dispatch(accountActions.setCurrent(currentAccount));

          const accounts = await wallet.getAccounts();
          dispatch(accountActions.setAccounts(accounts));

          if (accounts.length > 0) {
            self.accountLoaded = true;
          }
        }
      }

      if (!self.settingsLoaded) {
        const chainType = await wallet.getChainType();
        dispatch(
          settingsActions.updateSettings({
            chainType
          })
        );

        const _locale = await wallet.getLocale();
        dispatch(settingsActions.updateSettings({ locale: _locale }));
        self.settingsLoaded = true;
      }

      // already load when reloadAccounts
      // wallet.getWalletConfig().then((data) => {
      //   dispatch(settingsActions.updateSettings({ walletConfig: data }));
      // });
      readQuietly(
        'skippedVersion',
        () => wallet.getSkippedVersion(),
        (data) => dispatch(settingsActions.updateSettings({ skippedVersion: data }))
      );
      readQuietly(
        'autoLockTimeId',
        () => wallet.getAutoLockTimeId(),
        (data) => dispatch(settingsActions.updateSettings({ autoLockTimeId: data }))
      );
      readQuietly(
        'developerMode',
        () => wallet.getDeveloperMode(),
        (data) => dispatch(settingsActions.updateSettings({ developerMode: data }))
      );
    };

    // Whether a wallet is set up, and unlocked, read beside the rest.
    const loadVault = async () => {
      if (self.vaultLoaded) return;
      if (await wallet.hasVault()) {
        dispatch(globalActions.update({ isBooted: true }));
        const unlocked = await wallet.isUnlocked();
        dispatch(globalActions.update({ isUnlocked: unlocked }));
      }
      self.vaultLoaded = true;
    };

    // The id of the wallet set up, for the checks after a reconnection and
    // at each unlock (recordShownWalletId). Asked first, so the account this
    // run reads goes out after it: what the page shows is never older than
    // the id it records, and a reset between the two leaves the account
    // newer, which those checks answer with a reload, never with an erased
    // wallet kept. Only for noticing a replaced wallet: an id that cannot be
    // read for its own reason, as when saving a new one fails, does not keep
    // the page from opening, and later runs ask again: those a lock or an
    // unlock starts, and a few after pauses (PAGE_WALLET_ID_RETRY_DELAYS_MS).
    // Until it holds one, a page that shows wallet content reopens at a
    // reconnection or an unlock, once (checkShownWallet). A reset or the
    // completion of one is told apart by the other reads, sent with this
    // one: it refuses every call the page makes while it runs, so the run
    // still fails through them and is retried. Null while nothing is booted:
    // later runs read it again, the first-run page's once its own wallet is
    // unlocked. Each definite answer also keeps the wallet-derived keys of
    // localStorage with their wallet (reconcileStoredWalletData).
    const readWalletId = async (): Promise<string | undefined> => {
      if (self.walletIdRecorded) return undefined;
      let id: unknown;
      try {
        id = await wallet.getWalletId();
      } catch {
        self.walletIdReadFailed = true;
        return undefined;
      }
      if (id !== null && (typeof id !== 'string' || id === '')) {
        self.walletIdReadFailed = true;
        return undefined;
      }
      self.walletIdReadFailed = false;
      const { dropLoadedUi } = reconcileStoredWalletData(id);
      if (dropLoadedUi) {
        // Loaded the erased wallet's display preferences: a save would put them back.
        dispatch(uiActions.reset(undefined));
      }
      return id ?? undefined;
    };

    try {
      const [id] = await Promise.all([readWalletId(), loadAccountAndSettings(), loadVault()]);
      // Recorded together with the state it belongs to: only once the reads
      // sent after it have succeeded. A page that showed an account without
      // the id adopts one only with what it shows never older than the id:
      // unlocked, it reads its wallets again after the id; locked, it cannot,
      // since a locked wallet names no account and lists no wallets at all,
      // so it drops what it shows, which the next unlock reads again after
      // the id (readAccount). A page holding no id that shows wallet content
      // is reopened at a reconnection or an unlock instead (checkShownWallet).
      if (id !== undefined) {
        if (accountShownBefore && !isUnlocked) {
          dispatch(accountActions.reset(undefined));
          dispatch(keyringsActions.reset(undefined));
          dispatch(transactionsActions.reset(undefined));
          self.accountLoaded = false;
          self.walletsDropped = true;
        } else if (accountShownBefore) {
          const keyrings = await wallet.getKeyrings();
          dispatch(keyringsActions.setKeyrings(keyrings));
          const currentKeyring = await wallet.getCurrentKeyring();
          dispatch(keyringsActions.setCurrent(currentKeyring));
        }
        recordShownWalletId(id);
        self.walletIdRecorded = true;
      } else if (self.walletsDropped && isUnlocked && self.accountLoaded) {
        // The wallets of the account this run read again, after the id.
        const keyrings = await wallet.getKeyrings();
        dispatch(keyringsActions.setKeyrings(keyrings));
        const currentKeyring = await wallet.getCurrentKeyring();
        dispatch(keyringsActions.setCurrent(currentKeyring));
        self.walletsDropped = false;
      }
      dispatch(globalActions.update({ isReady: true }));
    } catch (e) {
      console.log('init error', e);
      throw e;
    }
  }, [wallet, dispatch, isReady, isUnlocked]);

  // One run of the routine at a time, the latest one each time.
  const runsRef = useRef({
    running: false,
    again: false,
    closed: false,
    retriedByHand: false,
    // The runs made again for an id read that failed, and the pause before
    // the next one.
    idRetries: 0,
    idRetryTimer: undefined as ReturnType<typeof setTimeout> | undefined
  });
  const initRef = useRef(init);
  initRef.current = init;
  const startRuns = useCallback(() => {
    const runs = runsRef.current;
    if (runs.running) {
      runs.again = true;
      return;
    }
    runs.running = true;
    const loop = (async () => {
      try {
        let outcome: 'started' | 'failed' | 'stopped';
        do {
          runs.again = false;
          outcome = await startWithRetries(() => initRef.current(), { stopped: () => runs.closed });
        } while (runs.again && !runs.closed);
        if (outcome === 'failed' && !runs.closed) {
          setStartFailed(runs.retriedByHand ? 'again' : 'page');
        }
        // A page that started without the id, its read having failed for its
        // own reason, asks again a few times, quietly, less and less often.
        // Each run reads the account and the wallets again after the id, as
        // for any late id, so what the page shows is never older than it.
        if (
          outcome === 'started' &&
          !runs.closed &&
          !self.walletIdRecorded &&
          self.walletIdReadFailed &&
          runs.idRetryTimer === undefined &&
          runs.idRetries < PAGE_WALLET_ID_RETRY_DELAYS_MS.length
        ) {
          runs.idRetryTimer = setTimeout(() => {
            runs.idRetryTimer = undefined;
            if (!runs.closed) startRuns();
          }, PAGE_WALLET_ID_RETRY_DELAYS_MS[runs.idRetries++]);
        }
      } finally {
        runs.running = false;
      }
    })();
    // While the page holds no id, these runs read it: a request the wallet
    // proxy holds for the id waits for them (waitForShownWalletId).
    if (!self.walletIdRecorded) noteWalletIdRead(loop);
  }, [self]);

  useEffect(() => {
    startRuns();
  }, [init, startRuns]);

  useEffect(() => {
    const runs = runsRef.current;
    return () => {
      runs.closed = true;
      clearTimeout(runs.idRetryTimer);
    };
  }, []);

  // This page's own start-up only: the background started, so restarting the
  // extension, which closes every other wallet window, is offered only once
  // this has failed again.
  const retry = useCallback(() => {
    runsRef.current.retriedByHand = true;
    setStartFailed(false);
    startRuns();
  }, [startRuns]);

  if (isReady) {
    return <>{children}</>;
  }

  if (startFailed) {
    // After a failed Retry, the screen shown after a background failure: its
    // Retry restarts the extension, which the screen says.
    return <StartupErrorScreen reason="unknown" onRetry={startFailed === 'page' ? retry : undefined} />;
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '400vw',
        height: '00vh',
        overflowY: 'auto',
        overflowX: 'hidden'
      }}
    >
      <Content justifyCenter itemsCenter>
        <Icon>
          <LoaderCircle className="icon-spin" size="1em" />
        </Icon>
      </Content>
    </div>
  );
}
