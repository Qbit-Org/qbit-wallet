/**
 * Page hold module
 * Stops a denylisted page before its own script runs, until the background
 * answers
 */
import { normalizeHostname } from '@qbit/phishing-detect';

import { isTopFrame } from '../frame';
import { initializePhishingDetection, isExtensionContextValid, navigationType, type PhishingVerdict } from './detector';
import { isBundledDenylistedUrl } from './navigation';
import { isReleased, recordRelease } from './release';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const NOTICE_ID = 'qbit-wallet-phishing-notice';

// How long the background has to answer for a held page, and then to
// replace it with the warning page, before the page explains itself.
export const WARNING_PAGE_TIMEOUT_MS = 3_000;

/**
 * Why a held page shows a notice: the background did not answer or no
 * warning page arrived, the page cannot be released, it was released but
 * must not reload by itself, or it was released but its history entry may
 * keep a form that a reload would send again.
 */
type NoticeReason = 'unanswered' | 'unreleasable' | 'released' | 'reloadRefused';

const FALLBACK_TEXT = {
  title: 'Danger! Potential phishing website detected',
  unanswered:
    'Qbit Wallet stopped this page before it could run, because the site is on its list of phishing websites. The wallet did not answer in time to open its full warning or let the page load. Try again, or close this tab.',
  unreleasable:
    'Qbit Wallet stopped this page before it could run, because the site is on its list of phishing websites. It cannot let the page load, as the page does not keep the record that this needs. Try again, or close this tab.',
  released:
    'Qbit Wallet stopped this page before it could run, because the site is on its list of phishing websites. Select Try again to load it, or close this tab.',
  reloadRefused:
    'Qbit Wallet stopped this page before it could run, because the site is on its list of phishing websites. It can let the page load now, but a reload could send again a form that opened the page. Select Try again to open its address afresh, without the form, or close this tab.',
  retry: 'Try again'
};

const NOTICE_MESSAGES: Record<NoticeReason, string> = {
  unanswered: 'phishing_page_held_message',
  unreleasable: 'phishing_page_held_unreleasable_message',
  released: 'phishing_page_held_released_message',
  reloadRefused: 'phishing_page_held_reload_refused_message'
};

/**
 * Whether this load may be a reload, which the release must not repeat. A
 * load whose navigation the browser does not report counts as one.
 */
function isReload(): boolean {
  const type = navigationType();
  return type === undefined || type === 'reload';
}

/**
 * Reloads the page with a GET. When a form POST loaded the page, its server
 * got the form before the hold stopped the page, and the page's history entry
 * keeps the form, which a reload would send again. Replacing the entry with
 * itself, with the same state and URL, drops the form; the load still counts
 * as a reload. Returns false, without reloading, when the history refuses, as
 * the reload could then send the form again.
 */
function reloadWithGet(): boolean {
  try {
    window.history.replaceState(window.history.state, '');
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/**
 * Opens the page's address again as a new load, which is always a GET, so
 * that a form that loaded the page is not sent again even when the history
 * refuses to drop it. The new load replaces the page's history entry, and
 * with it the form. The address loses its fragment, as opening the same
 * address with one would only scroll the stopped page.
 */
function openWithGet(): void {
  const url = new URL(window.location.href);
  url.hash = '';
  window.location.replace(url.href);
}

/**
 * Loads the page again without sending a form that loaded it: a reload when
 * the history drops the form, and otherwise a new load of its address.
 */
function loadAgain(): void {
  if (!reloadWithGet()) openWithGet();
}

function message(name: string, fallback: string): string {
  try {
    return chrome.i18n.getMessage(name) || fallback;
  } catch {
    return fallback;
  }
}

/** A top-frame page on a denylisted host whose load was stopped. */
export class HeldPage {
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param mayReload whether a release may reload the page without the user
   *   asking. A page held again on a reload may have lost its release, for
   *   example to a `Clear-Site-Data` header, and reloading once more could
   *   loop.
   */
  constructor(
    private readonly hostname: string,
    private mayReload: boolean
  ) {
    // A check that never answers does not leave a blank page.
    this.noticeTimer = setTimeout(() => this.showNotice('unanswered'), WARNING_PAGE_TIMEOUT_MS);
  }

  /**
   * Acts on the background's verdict. A page the background lets through is
   * released and reloaded with a GET, so that a form POST that loaded it is
   * not sent again, unless its sessionStorage cannot keep the release,
   * as on a sandboxed page or one whose site data is blocked: it stays held,
   * so that its server cannot turn the hold off. A released page that must
   * not reload by itself, or whose history refuses to drop the form, waits
   * behind a notice for the user to load it. Otherwise the page stays
   * held too: the background is
   * sending a phishing page to the warning page, and a page whose check did
   * not complete gets a notice it can retry from.
   */
  settle(verdict: PhishingVerdict): void {
    clearTimeout(this.noticeTimer);
    this.noticeTimer = undefined;
    if (verdict === 'proceeded' || verdict === 'clear') {
      if (!recordRelease(this.hostname)) {
        this.showNotice('unreleasable');
      } else if (!this.mayReload) {
        this.showNotice('released');
      } else if (!reloadWithGet()) {
        // Try again loads the page without the form instead of reaching this
        // again.
        this.showNotice('reloadRefused');
      }
      return;
    }
    if (verdict === 'phishing') {
      this.noticeTimer = setTimeout(() => this.showNotice('unanswered'), WARNING_PAGE_TIMEOUT_MS);
      return;
    }
    this.showNotice('unanswered');
  }

  private async retry(button: HTMLButtonElement): Promise<void> {
    // An extension that was updated or reloaded answers only a new content
    // script, which a new load of the page brings.
    if (!isExtensionContextValid()) {
      loadAgain();
      return;
    }
    button.disabled = true;
    // The page is still held, so the check can say so.
    const verdict = await initializePhishingDetection(true, true);
    button.disabled = false;
    // The user asked, so a release may reload the page.
    this.mayReload = true;
    this.settle(verdict);
  }

  /** Replaces the stopped page with a notice that names the host and offers a retry. */
  private showNotice(reason: NoticeReason): void {
    // HTML elements even in a document of another type, such as an SVG one.
    const create = (tag: string, text?: string): HTMLElement => {
      const element = document.createElementNS(XHTML_NAMESPACE, tag) as HTMLElement;
      if (text !== undefined) element.textContent = text;
      return element;
    };

    const notice = create('div');
    notice.id = NOTICE_ID;
    notice.setAttribute('role', 'alert');
    notice.style.cssText =
      'max-width:560px;margin:15vh auto;padding:0 16px;font:16px/1.5 system-ui,sans-serif;color:#1f1f1f;';
    const title = create('h1', message('danger_potential_phishing_website_detected', FALLBACK_TEXT.title));
    title.style.cssText = 'font-size:24px;margin:0 0 8px;color:#b3261e;';
    const host = create('p', this.hostname);
    host.style.cssText = 'font-weight:600;margin:0 0 16px;word-break:break-all;';
    const text = create('p', message(NOTICE_MESSAGES[reason], FALLBACK_TEXT[reason]));
    const button = create('button', message('try_again', FALLBACK_TEXT.retry)) as HTMLButtonElement;
    button.type = 'button';
    button.style.cssText = 'font:inherit;padding:8px 16px;cursor:pointer;';
    button.addEventListener('click', () => {
      // A page already released needs no new verdict, only a load that does
      // not send its form again.
      if (reason === 'reloadRefused') loadAgain();
      else void this.retry(button);
    });
    notice.append(title, host, text, button);

    const body = create('body');
    body.style.cssText = 'margin:0;background:#fff;';
    body.append(notice);
    // A body renders only under an HTML root, which an SVG document lacks.
    let root = document.documentElement;
    if (root?.namespaceURI !== XHTML_NAMESPACE) {
      const html = create('html');
      if (root) document.replaceChild(html, root);
      else document.appendChild(html);
      root = html;
    }
    root.replaceChildren(body);
  }
}

/**
 * Stops the page before its own script runs when it is a top-frame page on a
 * host the bundled policy covers, unless the background let it through
 * earlier in this tab. The content script calls this first, at
 * document_start, so the network layer missing, for example because its rule
 * failed to install, does not let the page run until the warning arrives. For
 * a `qbit.<tld>` lookalike that is not on the denylist, which no network rule
 * names, this is what stops the page.
 */
export function holdDenylistedPage(): HeldPage | undefined {
  if (!isTopFrame() || !isBundledDenylistedUrl(window.location.href)) return undefined;

  const hostname = normalizeHostname(window.location.hostname);
  if (isReleased(hostname)) return undefined;

  window.stop();
  return new HeldPage(hostname, !isReload());
}
