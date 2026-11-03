// Settings shell, keyboard access, responsive layout, and persistence semantics.
;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const until = async (name, check) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const result = check()
      if (result) return result
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Timed out waiting for ${name}`)
  }
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  const dialog = () => document.querySelector('.settings-dialog [role="dialog"]')
  const key = (element, key, shiftKey = false) =>
    element.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }))
  try {
    smoke.acceptOpened(await smoke.openProject())
    await smoke.resizeWindow(1000, 800)
    for (const [setting, title] of [
      ['roles', 'Agent roles'],
      ['notifications', 'Notifications'],
      ['profiles', 'Agent profiles'],
      ['worktree-setup', 'Worktree setup'],
      ['integrations', 'Agent providers'],
      ['extensions', 'Extensions'],
      ['editor', 'Preferred editor'],
    ]) {
      const trigger = document.querySelector('.workspace-rail button')
      trigger.focus()
      if (setting === 'extensions') smoke.store.getState().setExtensionsPanelOpen(true)
      else if (setting === 'editor')
        window.dispatchEvent(new CustomEvent('patchbay:editor-settings'))
      else smoke.rail.setState({ settings: setting })
      const card = await until(
        title,
        () => dialog()?.getAttribute('aria-label') === title && dialog(),
      )
      assert(card.querySelector('.settings-description'), `${title}: missing save behavior`)
      await until('initial focus', () => card.contains(document.activeElement))
      const close = card.querySelector(`button[aria-label="Close ${title}"]`)
      assert(close, `${title}: missing close button`)
      close.focus()
      key(close, 'Tab', true)
      assert(
        card.contains(document.activeElement) && document.activeElement !== close,
        `${title}: reverse focus trap failed`,
      )
      key(document.activeElement, 'Tab')
      assert(document.activeElement === close, `${title}: forward focus trap failed`)
      await smoke.resizeWindow(520, 700)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const body = card.querySelector('.dialog-body')
      assert(
        body.scrollWidth <= body.clientWidth + 1,
        `${title}: horizontal overflow (${body.scrollWidth}/${body.clientWidth}): ${[
          ...body.querySelectorAll('*'),
        ]
          .filter(
            (el) => el.getBoundingClientRect().right > body.getBoundingClientRect().right - 24,
          )
          .map(
            (el) =>
              el.tagName + '.' + el.className + ':' + Math.round(el.getBoundingClientRect().width),
          )
          .join(', ')}`,
      )
      const footer = card.querySelector('.settings-footer')
      if (footer) {
        body.scrollTop = body.scrollHeight
        assert(
          footer.getBoundingClientRect().bottom <= innerHeight,
          `${title}: footer outside window`,
        )
      }
      if (setting === 'notifications') {
        const enabled = card.querySelector('input[type="checkbox"]')
        const before = smoke.store.getState().notifications.enabled
        enabled.click()
        await until(
          'immediate preference',
          () => smoke.store.getState().notifications.enabled !== before,
        )
        enabled.click()
      }
      key(card, 'Escape')
      await until('closed dialog', () => !dialog())
      assert(document.activeElement === trigger, `${title}: focus was not restored`)
      await smoke.resizeWindow(1000, 800)
    }
    smoke.report('PASS settings dialogs: shared shell, focus, narrow layout, immediate preferences')
  } catch (e) {
    smoke.report(`FAIL ${e?.message ?? e}`)
  }
})()
