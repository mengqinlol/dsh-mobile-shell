// Mobile shell glue injected into index.html: drawer scrim, viewport lock,
// keyboard-aware height, and auto-close on conversation switch.
//
// 1) iOS zooms the page when a focused field computes below 16px; the composer
//    is a contenteditable div, so the fix lives in CSS (16px) plus this script
//    locking the viewport as a second line of defence.
// 2) iOS does not shrink the layout viewport for the on-screen keyboard, so the
//    composer would sit underneath it. visualViewport tracks the keyboard, so
//    its height feeds a CSS variable the shell height reads.
// 3) DSH has no "close the sidebar after picking a conversation"; the drawer
//    would stay open over the chat. A title mutation (which is what a session
//    switch changes) collapses it.
(function () {
  if (window.__dshMobileShell) return;
  window.__dshMobileShell = true;

  var scrim = null;
  var narrow = window.matchMedia("(max-width: 820px)");

  function collapseButton() {
    var buttons = document.querySelectorAll("button");
    for (var index = 0; index < buttons.length; index += 1) {
      var label = buttons[index].getAttribute("aria-label") || "";
      if (label.indexOf("收起侧边栏") >= 0 || label.indexOf("Collapse sidebar") >= 0) return buttons[index];
    }
    return null;
  }

  function removeScrim() {
    if (scrim === null) return;
    scrim.remove();
    scrim = null;
  }

  function addScrim() {
    if (scrim !== null) return;
    scrim = document.createElement("div");
    scrim.setAttribute("data-dsh-mobile-scrim", "");
    scrim.style.cssText = "position:fixed;inset:0;z-index:35;background:rgba(0,0,0,0.45);-webkit-tap-highlight-color:transparent;";
    scrim.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      collapseDrawer();
    });
    document.body.appendChild(scrim);
  }

  function collapseDrawer() {
    var button = collapseButton();
    if (button !== null) button.click();
    removeScrim();
  }

  // ── viewport lock ──────────────────────────────────────────────────────
  // iOS Safari ignores user-scalable=no since iOS 10, so the focus-zoom fix is
  // the 16px field size in CSS; this still stops Android/Chrome pinch-zoom and
  // keeps the layout viewport stable.
  var viewportMeta = document.querySelector('meta[name="viewport"]');
  if (viewportMeta !== null) {
    viewportMeta.setAttribute(
      "content",
      "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover",
    );
  }
  document.addEventListener("gesturestart", function (event) {
    event.preventDefault();
  }, { passive: false });

  // ── keyboard-aware inset ───────────────────────────────────────────────
  // iOS reports the keyboard only through visualViewport, and it reports
  // intermediate values while the keyboard animates. Shrinking the shell to
  // that value collapsed the whole layout into a sliver, so the shell keeps its
  // height and the conversation column is shifted up by a clamped inset:
  //   inset = layoutHeight - visualViewport.height, accepted only when it looks
  //   like a keyboard (80px .. 55% of the screen) and re-sampled for ~1.2s
  //   after focus, because iOS sometimes fires resize only at the animation
  //   start.
  var root = document.documentElement;
  var settleTimer = null;

  function syncKeyboardInset() {
    var vv = window.visualViewport;
    var layout = window.innerHeight;
    if (vv === undefined || vv === null || layout <= 0) {
      root.style.setProperty("--dsh-keyboard-inset", "0px");
      return;
    }
    var inset = Math.round(layout - vv.height);
    var plausible = inset > 80 && inset < layout * 0.55;
    root.style.setProperty("--dsh-keyboard-inset", plausible ? inset + "px" : "0px");
  }

  function settleInset() {
    var ticks = 0;
    window.clearInterval(settleTimer);
    syncKeyboardInset();
    settleTimer = window.setInterval(function () {
      syncKeyboardInset();
      ticks += 1;
      if (ticks > 12) window.clearInterval(settleTimer);
    }, 100);
  }

  if (window.visualViewport !== undefined && window.visualViewport !== null) {
    window.visualViewport.addEventListener("resize", syncKeyboardInset);
    window.visualViewport.addEventListener("scroll", syncKeyboardInset);
  }
  window.addEventListener("orientationchange", settleInset);
  window.addEventListener("resize", syncKeyboardInset);
  document.addEventListener("focusin", settleInset, true);
  document.addEventListener("focusout", function () {
    window.setTimeout(syncKeyboardInset, 250);
  }, true);
  syncKeyboardInset();

  // ── no autofocus when a conversation opens ─────────────────────────────
  // DSH focuses the composer whenever a session view mounts, which pops the
  // keyboard over the conversation the user just asked to read (and on iOS can
  // drag the whole layout around). Keep focus only when the tap came from
  // inside the composer; anything programmatic is dropped immediately, in the
  // same task as focusin, so the keyboard never starts to appear.
  // A short retry loop catches shells that re-assert focus right after mount.
  var composerTapAt = 0;
  var stats = window.__dshMobileStats = window.__dshMobileStats || { blurred: 0, allowed: 0 };
  document.addEventListener("pointerdown", function (event) {
    var target = event.target;
    if (target instanceof Element && target.closest("[data-composer-card]") !== null) composerTapAt = Date.now();
  }, true);

  function isComposerEditor(node) {
    if (!(node instanceof Element)) return false;
    var editable =
      node.getAttribute("contenteditable") === "true" || node.tagName === "TEXTAREA" || node.tagName === "INPUT";
    return editable && node.closest("[data-composer-card]") !== null;
  }

  function dropAutofocus() {
    var active = document.activeElement;
    if (!isComposerEditor(active)) return;
    if (Date.now() - composerTapAt < 800) return;
    active.blur();
    stats.blurred += 1;
  }

  document.addEventListener("focusin", function (event) {
    if (!narrow.matches) return;
    if (!isComposerEditor(event.target)) return;
    if (Date.now() - composerTapAt < 800) {
      stats.allowed += 1;
      return;
    }
    // Drop now (keeps the iOS keyboard from starting) and again on the next
    // frames in case the mount effect re-focuses.
    dropAutofocus();
    var tries = 0;
    var retry = window.setInterval(function () {
      dropAutofocus();
      tries += 1;
      if (tries > 20) window.clearInterval(retry);
    }, 100);
  }, true);

  // ── drawer scrim + auto-close on conversation switch ────────────────────
  function watch() {
    var panel = document.querySelector('[data-slot="sidebar"] > div');
    if (panel === null) {
      window.setTimeout(watch, 400);
      return;
    }

    // Workspace-file browser entry: an absolutely positioned row inside the
    // drawer, so it needs no DSH DOM surgery and disappears with the drawer.
    // The page itself is served by this plugin at /api/workspace-files and
    // rides the same session cookie as the GUI.
    var filesLink = null;
    var syncFilesLink = function () {
      if (!narrow.matches) {
        if (filesLink !== null) { filesLink.remove(); filesLink = null; }
        return;
      }
      var open = panel.getBoundingClientRect().width > 100;
      if (!open || !panel.isConnected) {
        if (filesLink !== null) { filesLink.remove(); filesLink = null; }
        return;
      }
      if (filesLink !== null && filesLink.isConnected) return;
      filesLink = document.createElement("a");
      filesLink.href = "/api/workspace-files";
      filesLink.textContent = "📁 工作区文件";
      filesLink.setAttribute("data-dsh-files-link", "");
      filesLink.style.cssText =
        "position:absolute;left:12px;right:12px;bottom:72px;display:flex;align-items:center;" +
        "gap:8px;padding:10px 12px;border-radius:10px;color:inherit;text-decoration:none;" +
        "font:inherit;background:rgba(127,127,127,0.14);-webkit-tap-highlight-color:transparent;";
      // Re-attach when the shell re-renders the panel contents.
      panel.appendChild(filesLink);
    };

    var sync = function () {
      var open = narrow.matches && panel.getBoundingClientRect().width > 100;
      if (open) addScrim();
      else removeScrim();
      try {
        syncFilesLink();
      } catch (error) {
        // The entry point is a convenience; the page URL always works.
        if (window.console) window.console.warn("dsh-mobile-shell: files link failed", error);
      }
    };
    if (typeof ResizeObserver === "function") new ResizeObserver(sync).observe(panel);
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    sync();

    // Switching conversation rewrites the document title; that is the signal
    // (the SPA keeps one URL). Collapsing on a title change also covers the
    // "new conversation" button.
    var titleNode = document.head.querySelector("title");
    if (titleNode !== null) {
      new MutationObserver(function () {
        if (narrow.matches && panel.getBoundingClientRect().width > 100) collapseDrawer();
      }).observe(titleNode, { childList: true, characterData: true, subtree: true });
    }
  }

  watch();
})();
