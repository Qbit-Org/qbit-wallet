import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

/** The settings screens that list entries which open a screen of their own. */
export type SettingsParentPath = '/settings/security' | '/settings/advanced';

/**
 * Back for a screen that an entry of Security or Advanced Settings opens.
 *
 * With history behind the screen, Back is history Back. Opened as the first
 * history entry (directly by URL, for example) there is nothing behind it
 * (react-router marks the first entry with idx 0), so the chain a user would
 * have walked is rebuilt: Settings takes this entry's place and `parent` is
 * pushed after it. This Back then lands on the parent, and the parent's own
 * Back lands on Settings. Pushing the parent alone would make its Back return
 * to this screen in a loop.
 */
export function useBackToSettingsParent(parent: SettingsParentPath): () => void {
  const navigate = useNavigate();

  return useCallback(() => {
    const historyIndex = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (historyIndex > 0) {
      window.history.go(-1);
      return;
    }
    navigate('/settings', { replace: true });
    navigate(parent);
  }, [navigate, parent]);
}
