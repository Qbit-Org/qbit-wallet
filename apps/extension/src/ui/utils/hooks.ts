import { useEffect, useRef, useState } from 'react';

const WALLET_KEEPALIVE_INTERVAL_MS = 10 * 1000;
const WALLET_KEEPALIVE_GRACE_PERIOD_MS = 10 * 60 * 1000;

// Keeps the wallet unlocked for at most ten minutes while a screen that walks
// the user through an unencrypted mnemonic (onboarding, recovery migration)
// stays mounted. The monotonic elapsed check, the backward-jump check, and the
// wall-clock deadline each independently end the grace period, so neither a
// frozen monotonic clock nor a shifted wall clock can extend it. Each refresh
// re-arms the background lock timer for the user's full auto-lock duration —
// possibly hours — so the deadline is enforced with an explicit lock instead
// of waiting out the timer the last refresh armed.
export const useWalletKeepalive = (wallet: { setLastActiveTime(): void; lockWallet(): void }) => {
  const beginTimeRef = useRef<number>(performance.now());
  const lastWallClockTimeRef = useRef<number>(Date.now());
  const wallClockDeadlineRef = useRef<number>(lastWallClockTimeRef.current + WALLET_KEEPALIVE_GRACE_PERIOD_MS);
  useEffect(() => {
    let lockRequested = false;
    const enforceDeadline = () => {
      if (lockRequested) return;
      lockRequested = true;
      try {
        // A rejected lock (transient port failure) re-arms the retry on the
        // next interval tick.
        Promise.resolve(wallet.lockWallet()).catch(() => {
          lockRequested = false;
        });
      } catch {
        lockRequested = false;
      }
    };
    const lockTimeout = setTimeout(enforceDeadline, WALLET_KEEPALIVE_GRACE_PERIOD_MS);
    let wallClockUntrusted = false;
    const interval = setInterval(() => {
      const wallClockTime = Date.now();
      if (
        performance.now() - beginTimeRef.current >= WALLET_KEEPALIVE_GRACE_PERIOD_MS ||
        wallClockTime >= wallClockDeadlineRef.current
      ) {
        // Deadline reached: stop refreshing and lock now, which also covers a
        // lock timeout the browser throttled; the interval keeps ticking so a
        // failed lock request is retried.
        enforceDeadline();
        return;
      }
      if (wallClockTime < lastWallClockTimeRef.current) {
        // The wall clock moved backwards, so its deadline can no longer be
        // trusted: stop extending the grace period, permanently — a later
        // forward jump must not resume refreshes.
        wallClockUntrusted = true;
      }
      if (wallClockUntrusted) {
        // Keep the interval ticking so the monotonic deadline above is still
        // enforced even if the browser throttled the scheduled lock, and so a
        // failed lock request is retried.
        return;
      }

      lastWallClockTimeRef.current = wallClockTime;
      try {
        // The interface types setLastActiveTime as void, but the background
        // implementation is async; a refresh rejected by a locking wallet must
        // not become an unhandled rejection.
        Promise.resolve(wallet.setLastActiveTime()).catch(() => undefined);
      } catch {
        // ignore
      }
    }, WALLET_KEEPALIVE_INTERVAL_MS);

    return () => {
      clearTimeout(lockTimeout);
      clearInterval(interval);
    };
  }, []);
};

export const useSelectOption = <T>({
  options,
  defaultValue = [],
  onChange,
  value
}: {
  options: T[];
  defaultValue?: T[];
  onChange?: (arg: T[]) => void;
  value?: T[];
}) => {
  const isControlled = useRef(typeof value !== 'undefined').current;
  const [idxs, setChoosedIdxs] = useState((isControlled ? value! : defaultValue).map((x) => options.indexOf(x)));

  useEffect(() => {
    if (!isControlled) {
      return;
    }

    // shallow compare
    if (value && idxs.some((x, i) => options[x] != value[i])) {
      setChoosedIdxs(value.map((x) => options.indexOf(x)));
    }
  }, [value]);

  const changeValue = (idxs: number[]) => {
    setChoosedIdxs([...idxs]);
    onChange && onChange(idxs.map((o) => options[o]));
  };

  const handleRemove = (i: number) => {
    idxs.splice(i, 1);
    changeValue(idxs);
  };

  const handleChoose = (i: number) => {
    if (idxs.includes(i)) {
      return;
    }

    idxs.push(i);
    changeValue(idxs);
  };

  const handleToggle = (i: number) => {
    const inIdxs = idxs.indexOf(i);
    if (inIdxs !== -1) {
      handleRemove(inIdxs);
    } else {
      handleChoose(i);
    }
  };

  const handleClear = () => {
    changeValue([]);
  };

  return [idxs.map((o) => options[o]), handleRemove, handleChoose, handleToggle, handleClear, idxs] as const;
};

export const useWalletRequest = (
  requestFn,
  {
    onSuccess,
    onError
  }: {
    onSuccess?(arg: any): void;
    onError?(arg: any): void;
  }
) => {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);
  const [loading, setLoading] = useState<boolean>(false);
  const [res, setRes] = useState<any>();
  const [err, setErr] = useState<any>();

  const run = async (...args) => {
    setLoading(true);
    try {
      const _res = await Promise.resolve(requestFn(...args));
      if (!mounted.current) {
        return;
      }
      setRes(_res);
      onSuccess && onSuccess(_res);
    } catch (err) {
      if (!mounted.current) {
        return;
      }
      setErr(err);
      onError && onError(err);
    } finally {
      if (mounted.current) {
        setLoading(false);
      }
    }
  };

  return [run, loading, res, err] as const;
};
export interface UseHoverOptions {
  mouseEnterDelayMS?: number;
  mouseLeaveDelayMS?: number;
}

export type HoverProps = Pick<React.HTMLAttributes<HTMLElement>, 'onMouseEnter' | 'onMouseLeave'>;

export const useHover = ({ mouseEnterDelayMS = 0, mouseLeaveDelayMS = 0 }: UseHoverOptions = {}): [
  boolean,
  HoverProps
] => {
  const [isHovering, setIsHovering] = useState(false);
  let mouseEnterTimer: number | undefined;
  let mouseOutTimer: number | undefined;
  return [
    isHovering,
    {
      onMouseEnter: () => {
        clearTimeout(mouseOutTimer);
        mouseEnterTimer = window.setTimeout(() => setIsHovering(true), mouseEnterDelayMS);
      },
      onMouseLeave: () => {
        clearTimeout(mouseEnterTimer);
        mouseOutTimer = window.setTimeout(() => setIsHovering(false), mouseLeaveDelayMS);
      }
    }
  ];
};
