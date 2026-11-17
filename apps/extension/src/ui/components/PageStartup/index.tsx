import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'react-redux';

import type { Account } from '@qbit/wallet-shared';
import {
  accountActions,
  type AppState,
  globalActions,
  keyringsActions,
  settingsActions,
  transactionsActions,
  uiActions,
  useAppDispatch,
  useIsReady,
  useIsUnlocked,
  useTools,
  useWallet
} from '@qbit/wallet-state';

import {
  beginWalletIdRecovery,
  endWalletIdRecovery,
  onWalletIdRefusal,
  pageShowsWalletContent,
  recordShownWalletId,
  reconcileStoredWalletData
} from '@/ui/utils/walletReset';

import { StartupErrorScreen } from '../StartupErrorScreen';
import { WaitingPage } from '../WaitingPage';

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
 * Locks and unlocks start runs of their own meanwhile. Until the last of
 * them has run, the page is recovering its id by itself: what it refuses for
 * want of the id reopens nothing (beginWalletIdRecovery).
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

/** PageStartup's runs of its start-up routine. */
interface Runs {
  running: boolean;
  again: boolean;
  closed: boolean;
  retriedByHand: boolean;
  // The runs made again for an id read that failed, and the pause before the next one.
  idRetries: number;
  idRetryTimer: ReturnType<typeof setTimeout> | undefined;
  // This page noted a recovery of its id (beginWalletIdRecovery) not yet ended.
  recovering: boolean;
}

/**
 * Ends the page's recovery of its id (endWalletIdRecovery) once it is over:
 * a run has recorded the id, or no retry is scheduled, or the page closed.
 * Called once the runs have stopped, and at the close.
 */
function endRecoveryIfOver(startup: { walletIdRecorded: boolean }, runs: Runs): void {
  if (!runs.recovering) return;
  if (!startup.walletIdRecorded && !runs.closed && runs.idRetryTimer !== undefined) return;
  runs.recovering = false;
  endWalletIdRecovery(startup.walletIdRecorded ? 'recovered' : runs.closed ? 'closed' : 'given-up');
}

/**
 * The wallet pages, once the page's start-up reads have loaded: the id of the
 * wallet set up, the current account, the settings, and whether a wallet is
 * set up and unlocked. A WaitingPage until then. A run of the reads that fails,
 * refused or otherwise, is made again after short pauses (startWithRetries);
 * a page that still cannot start shows the start-up error screen rather than
 * a spinner for ever, whose Retry runs this page's start-up again; once that
 * has failed too, its Retry restarts the extension, as after a failure of the
 * background's start-up. A page that has started stays as it is when a later
 * run fails, and nothing here reloads it. A page that opened without the id
 * of its wallet, its read having failed, asks for it again a few times; until
 * it holds it, a call that would carry anything of the wallet it shows is
 * refused in the page (createWalletProxy), and this tells the user so when
 * the page has stopped asking (onWalletIdRefusal). A run that records the id
 * replaces the page's accounts and wallets with those the background names
 * under it in that run, and drops its transactions; or drops them all. Its
 * settings, its route and what its screens hold in their own state stay.
 *
 * The routine runs again whenever the lock state or isReady changes, its own
 * dispatches included; one run at a time: a change during a run asks for one
 * more after it, which reads again only what has not loaded.
 */
export function PageStartup({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const dispatch = useAppDispatch();
  // What the page shows as this run applies what it read, which may have
  // changed since the run began.
  const store = useStore<AppState>();

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
  // One run of the routine at a time, the latest one each time.
  const runsRef = useRef<Runs>({
    running: false,
    again: false,
    closed: false,
    retriedByHand: false,
    idRetries: 0,
    idRetryTimer: undefined,
    recovering: false
  });
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
    // showed, at its next unlocked run.
    const holdsId = self.walletIdRecorded;
    const readAccount = !self.accountLoaded || !holdsId;
    const accountShownBefore = self.accountLoaded;

    // The current account and the accounts, as the background names them in
    // this run; shown only once the run has read everything it shows with
    // them (below).
    const loadAccountAndSettings = async () => {
      let read: { current: Account; accounts: Account[] } | null | undefined;
      if (readAccount) {
        const current = await wallet.getCurrentAccount();
        read = current ? { current, accounts: await wallet.getAccounts() } : null;
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
      return read;
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
    // Whether a vault is there now, asked again by a started page that holds
    // no id only when what it read changes what it knows of a wallet set up:
    // it records the id of one; it reads that nothing is booted while its
    // store says a wallet is; or the background names no account while the
    // page shows a wallet whose vault its store does not know of, which only
    // a vault known takes off the wallet's screens (turnLocked). What the
    // store says is then the background's answer, read after that id: a
    // wallet made in another window since the page found none, or none left.
    // Undefined when not asked; a page not started yet goes by the read of
    // its first run.
    const readVaultAgain = async (): Promise<boolean | undefined> =>
      isReady ? Boolean(await wallet.hasVault()) : undefined;
    // A vault found is published. None found only on a page that shows no
    // wallet content, so that one that keeps its content keeps the checks
    // that go by a wallet held (holdsWallet), and only when no lock-state
    // change came during the run (`again`), which the run after this one
    // goes by: a run that read "none" just before a wallet was made does not
    // undo the isBooted the create hook marks.
    const showVault = (vault: boolean | undefined) => {
      if (vault === true) {
        dispatch(globalActions.update({ isBooted: true }));
      } else if (vault === false && !runsRef.current.again && !pageShowsWalletContent(store.getState())) {
        dispatch(globalActions.update({ isBooted: false }));
      }
    };

    // The id of the wallet set up, for the checks after a reconnection and
    // at each unlock (recordShownWalletId), and for every call the page
    // makes (createWalletProxy). Asked first, so the account this run reads
    // goes out after it: what the page shows is never older than the id it
    // records, and a reset between the two leaves the account newer, which
    // the background answers, for a call carrying that id, with a refusal
    // and the page with a reload, never with an erased wallet kept.
    // An id that cannot be read for its own reason, as when saving a new one
    // fails, does not keep the page from opening, and later runs ask again:
    // those a lock or an unlock starts, and a few after pauses
    // (PAGE_WALLET_ID_RETRY_DELAYS_MS). But until it holds one, a page that
    // shows wallet content sends nothing that carries anything of that
    // wallet: such a call is refused in the page, without a reload while
    // these runs may still read the id (beginWalletIdRecovery); only the
    // reads that carry nothing of it and the lock go, and activity pings are
    // dropped. It also reopens at a reconnection or an unlock, once
    // (checkShownWallet). A reset or the
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

    // Drops the wallet content the page shows, as a locked page that cannot
    // read it again does: its account, its wallets and their transactions,
    // which the next unlocked run reads again (readAccount).
    const dropShownWallet = () => {
      const { accounts, keyrings } = store.getState();
      if (accounts.current.address === '' && accounts.accounts.length === 0 && keyrings.keyrings.length === 0) return;
      dispatch(accountActions.reset(undefined));
      dispatch(keyringsActions.reset(undefined));
      dispatch(transactionsActions.reset(undefined));
      self.accountLoaded = false;
      if (accountShownBefore) self.walletsDropped = true;
    };
    // The background named no current account. With a vault (`vault`, read
    // in this run, or else the one the store knows of), it is locked: in one
    // step, the page drops what it showed and turns locked, its vault
    // marked, so that Layout takes it to the unlock screen, and no screen
    // made from what it showed stays while the page shows no wallet content,
    // which lets it send its calls unjudged (createWalletProxy). Without a
    // vault known, nothing is set up yet, as on the first-run page once
    // Create Password has booted the background; or the page cannot tell,
    // and leaving the screens would take a guess. Nor while its lock state
    // changed as this run read (a change asks for another run, `again`),
    // which the run after this one goes by. Then it stays as it is: a page
    // without its id keeps what it showed, and goes on refusing (as before
    // the page could drop it).
    // A limit of this step: Layout leaves for the unlock screen in an
    // effect, and the router shows that screen a task later. For one commit
    // after the drop, the screens that were mounted render the emptied
    // store, and the calls their effects make then go out without an id,
    // judged by nothing. On the send screen those are, as measured
    // (lockWithoutWalletId.test.tsx): abandonQbitUtxoSnapshot, which
    // abandons one of its reads by id, getQbitSendPlan, getQbitUtxoSnapshot
    // and getApproval. None writes a wallet's data; a write added to a mount
    // or an update effect of a wallet screen would go out the same way.
    const turnLocked = (vault: boolean | undefined) => {
      if (runsRef.current.again || !(vault ?? store.getState().global.isBooted)) return;
      dropShownWallet();
      dispatch(globalActions.update({ isUnlocked: false, isBooted: true }));
    };
    const showAccount = (read: { current: Account; accounts: Account[] }) => {
      dispatch(accountActions.setCurrent(read.current));
      dispatch(accountActions.setAccounts(read.accounts));
      self.accountLoaded = read.accounts.length > 0;
    };

    try {
      const [id, read] = await Promise.all([readWalletId(), loadAccountAndSettings(), loadVault()]);
      if (holdsId) {
        // Judged by its id: what it reads is shown as it comes.
        if (read) showAccount(read);
        if (self.walletsDropped && isUnlocked && self.accountLoaded) {
          // The wallets of the account this run read again, after the id.
          const keyrings = await wallet.getKeyrings();
          dispatch(keyringsActions.setKeyrings(keyrings));
          const currentKeyring = await wallet.getCurrentKeyring();
          dispatch(keyringsActions.setCurrent(currentKeyring));
          self.walletsDropped = false;
        }
      } else if (id !== undefined) {
        // The id, recorded only with what the background answers under it in
        // this run, read after it: the page's current account, its accounts
        // and its wallets are replaced with those the background names now,
        // and its transactions dropped, or all of them dropped when it names
        // no account. Nothing in between: they go before the id is recorded,
        // and what replaces them comes after. What else the page holds stays
        // as it was: its settings, its route, and what its screens keep in
        // their own state, an open form or dialog built for what it showed.
        // A background that names no current account and has a vault is
        // locked, whatever the page remembered: the page turns locked, which
        // takes it to the unlock screen, whose unlock reads the account again
        // after the id.
        const [wallets, vault] = await Promise.all([
          read ? Promise.all([wallet.getKeyrings(), wallet.getCurrentKeyring()]) : undefined,
          readVaultAgain()
        ]);
        dropShownWallet();
        recordShownWalletId(id);
        self.walletIdRecorded = true;
        if (read && wallets) {
          showAccount(read);
          dispatch(keyringsActions.setKeyrings(wallets[0]));
          dispatch(keyringsActions.setCurrent(wallets[1]));
          self.walletsDropped = false;
        } else {
          turnLocked(vault);
        }
        showVault(vault);
      } else {
        // No id: what the background names is shown without one, and the
        // page sends nothing that carries anything of it (createWalletProxy).
        // A background that names no current account, locked with a vault
        // the page knows of, takes the page to the unlock screen showing
        // nothing (turnLocked): so it sends its unlock as a page opened
        // locked does, and the run after it reads the id and the account
        // together. One whose vault it does not know of is asked about it
        // here; nothing booted, too, while the store says a wallet is.
        const known = store.getState();
        const nothingBooted = !self.walletIdReadFailed;
        const askVault =
          (nothingBooted && known.global.isBooted) ||
          (read === null && !known.global.isBooted && pageShowsWalletContent(known));
        const vault = askVault ? await readVaultAgain() : undefined;
        if (read) {
          showAccount(read);
        } else if (read === null) {
          turnLocked(vault);
        }
        showVault(vault);
      }
      dispatch(globalActions.update({ isReady: true }));
    } catch (e) {
      console.log('init error', e);
      throw e;
    }
  }, [wallet, dispatch, store, isReady, isUnlocked]);

  const initRef = useRef(init);
  initRef.current = init;
  const startRuns = useCallback(() => {
    const runs = runsRef.current;
    if (runs.running) {
      runs.again = true;
      return;
    }
    runs.running = true;
    // While the page holds no id, these runs read it, and so do the retries
    // they schedule: the page recovers its id by itself meanwhile, and a call
    // it refuses for want of the id reopens nothing (beginWalletIdRecovery).
    if (!self.walletIdRecorded && !runs.recovering) {
      runs.recovering = true;
      beginWalletIdRecovery();
    }
    void (async () => {
      try {
        let outcome: 'started' | 'failed' | 'stopped';
        do {
          runs.again = false;
          outcome = await startWithRetries(() => initRef.current(), { stopped: () => runs.closed });
        } while (runs.again && !runs.closed);
        if (outcome === 'failed' && !runs.closed) {
          setStartFailed(runs.retriedByHand ? 'again' : 'page');
        }
        // A pause still pending once a run, one a lock or an unlock started,
        // has recorded the id is no longer wanted.
        if (self.walletIdRecorded && runs.idRetryTimer !== undefined) {
          clearTimeout(runs.idRetryTimer);
          runs.idRetryTimer = undefined;
        }
        // A page that started without the id, its read having failed for its
        // own reason, asks again a few times, quietly, less and less often.
        // Each run reads the account and the wallets again after the id, as
        // for any late id, so those in its store are never older than it.
        if (
          outcome === 'started' &&
          !runs.closed &&
          !self.walletIdRecorded &&
          self.walletIdReadFailed &&
          runs.idRetryTimer === undefined &&
          runs.idRetries < PAGE_WALLET_ID_RETRY_DELAYS_MS.length
        ) {
          // Never runs once the page has closed: its close clears it.
          runs.idRetryTimer = setTimeout(() => {
            runs.idRetryTimer = undefined;
            startRuns();
          }, PAGE_WALLET_ID_RETRY_DELAYS_MS[runs.idRetries++]);
        }
      } finally {
        runs.running = false;
        endRecoveryIfOver(self, runs);
      }
    })();
  }, [self]);

  useEffect(() => {
    startRuns();
  }, [init, startRuns]);

  // Once, for the page's whole life: only its close marks it closed.
  useEffect(() => {
    const runs = runsRef.current;
    const startup = selfRef.current;
    return () => {
      runs.closed = true;
      clearTimeout(runs.idRetryTimer);
      runs.idRetryTimer = undefined;
      endRecoveryIfOver(startup, runs);
    };
  }, []);

  // A call refused for want of the id once the page is no longer recovering
  // it, on a page that has used its one reopen, or the calls refused during
  // a recovery that gave up, tell the user why, whatever the screen that made
  // them does with the error (onWalletIdRefusal): one error toast, which a
  // later one replaces rather than stacks.
  const tools = useTools();
  useEffect(() => onWalletIdRefusal((message) => tools.toastError(message)), [tools]);

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

  return <WaitingPage />;
}
