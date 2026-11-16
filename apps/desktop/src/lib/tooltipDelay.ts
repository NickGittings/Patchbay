/** One pending pointer tooltip; keyboard focus bypasses the delay. */
export function tooltipDelay(show: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
  }
  return {
    cancel,
    pointer: () => {
      cancel()
      timer = setTimeout(show, 350)
    },
    focus: () => {
      cancel()
      show()
    },
  }
}
