/**
 * The list's own controls, shared by the page's toolbar and the rail's second
 * bar: the three filters as one chip row, and the search field.
 */

import { useEffect, useRef, useState } from '../react.js'
import { IconSearchOutlineRegular, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientState, Controller } from '../types.js'
import type { Translate } from '../locales.js'

/** The three list filters as one labelled chip row. */
export function FilterTabs({ filter, controller, t, compact }: {
  filter: ClientState['filter']
  controller: Controller
  t: Translate
  compact?: boolean
}) {
  const items: Array<[ClientState['filter'], string, string]> = [
    ['unread', 'filter.unread', 'u'],
    ['all', 'filter.all', 'a'],
    ['starred', 'filter.starred', 's'],
  ]
  return (
    <div className={`gf-pills${compact ? ' compact' : ''}`} role="group" aria-label={t('filter.label')}>
      {items.map(function (entry) {
        return (
          <Pill
            key={entry[0]}
            active={filter === entry[0]}
            title={entry[2]}
            aria-pressed={filter === entry[0]}
            onClick={function () { controller.setFilter(entry[0]) }}
          >
            {t(entry[1])}
          </Pill>
        )
      })}
    </div>
  )
}

export function SearchBox({ controller, t, value, inputRef, compact }: {
  controller: Controller
  t: Translate
  value: string
  inputRef: React.RefObject<HTMLInputElement>
  compact?: boolean
}) {
  const [text, setText] = useState(value)
  const timer = useRef(0)
  // A query that arrives from elsewhere (Escape, a source change) also cancels
  // the keystroke still waiting to be sent: otherwise it re-applies the text
  // the reader just cleared, a fifth of a second later.
  useEffect(function () {
    clearTimeout(timer.current)
    setText(value)
  }, [value])
  useEffect(function () {
    return function () { clearTimeout(timer.current) }
  }, [])
  function onChange(event: { target: { value: string } }) {
    const next = event.target.value
    setText(next)
    clearTimeout(timer.current)
    timer.current = window.setTimeout(function () { controller.setQuery(next) }, 120)
  }
  return (
    <Input
      ref={inputRef}
      className={`gf-search${compact ? ' compact' : ''}`}
      type="search"
      icon={<IconSearchOutlineRegular size={16} />}
      value={text}
      placeholder={t('search.placeholder')}
      aria-label={t('search.placeholder')}
      spellCheck={false}
      autoComplete="off"
      onChange={onChange}
    />
  )
}
