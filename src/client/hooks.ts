/** React hooks and the one-keyboard-owner arbitration for multiple surfaces. */

import { useEffect, useLayoutEffect, useRef, useState } from './react.js'
import type { RefObject } from './react.js'
import type { Controller } from './types.js'

const keyboardSurfaces = new Set<string>()
const keyboardOwner: { id: string | null } = { id: null }
let keyboardSeq = 0

export function useMount(controller: Controller): void {
  useEffect(function () {
    controller.mount()
    return function () { controller.unmount() }
  }, [controller])
}

export function useElementWidth(ref: RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(0)
  // Measure before the first paint: a 0 width renders the rail in its narrow
  // layout for one frame and then flips to the wide one, which reads as a jump.
  useLayoutEffect(function () {
    const el = ref.current
    if (!el) return
    let alive = true
    const observer = new ResizeObserver(function (entries) {
      if (alive) setWidth(entries[0].contentRect.width)
    })
    observer.observe(el)
    setWidth(el.clientWidth)
    return function () {
      alive = false
      observer.disconnect()
    }
  }, [ref])
  return width
}

export function useOutsideClose(
  ref: RefObject<HTMLElement>,
  active: boolean,
  onClose: () => void,
): void {
  useEffect(function () {
    if (!active) return
    const onPointer = function (event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const onKey = function (event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    return function () {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [active, ref, onClose])
}

export function useKeyboard(
  controller: Controller,
  searchRef: RefObject<HTMLInputElement>,
  rootRef: RefObject<HTMLElement>,
  enabled?: boolean,
): void {
  const idRef = useRef<string | null>(null)
  if (idRef.current === null) idRef.current = `gitfeed-keyboard-${++keyboardSeq}`

  useEffect(function () {
    if (!enabled) return
    const id = idRef.current
    if (id === null) return
    const el = rootRef.current
    keyboardSurfaces.add(id)
    keyboardOwner.id = id
    const activate = function () { keyboardOwner.id = id }
    if (el) {
      el.addEventListener('pointerdown', activate, true)
      el.addEventListener('focusin', activate, true)
    }
    return function () {
      keyboardSurfaces.delete(id)
      if (el) {
        el.removeEventListener('pointerdown', activate, true)
        el.removeEventListener('focusin', activate, true)
      }
      if (keyboardOwner.id === id) {
        keyboardOwner.id = null
        for (const other of keyboardSurfaces) keyboardOwner.id = other
      }
    }
  }, [rootRef, enabled])

  useEffect(function () {
    function onKey(event: KeyboardEvent) {
      if (!enabled) return
      if (keyboardOwner.id !== idRef.current) return
      const target = event.target as HTMLElement | null
      const tag = target && target.tagName ? target.tagName.toLowerCase() : ''
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || !!(target && target.isContentEditable)
      if (typing) {
        if (event.key === 'Escape') target?.blur()
        return
      }
      if (event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          event.preventDefault()
          controller.move(1)
          break
        case 'k':
        case 'ArrowUp':
          event.preventDefault()
          controller.move(-1)
          break
        case 'm':
          event.preventDefault()
          controller.toggleRead()
          break
        case 's':
          event.preventDefault()
          controller.toggleStar()
          break
        case 'o':
          event.preventDefault()
          controller.openCurrent()
          break
        case 'u':
          event.preventDefault()
          controller.setFilter('unread')
          break
        case 'a':
          event.preventDefault()
          controller.setFilter('all')
          break
        case '/':
          event.preventDefault()
          searchRef.current?.focus()
          break
        case 'Escape':
          event.preventDefault()
          controller.escape()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return function () { window.removeEventListener('keydown', onKey) }
  }, [controller, searchRef, enabled])
}
