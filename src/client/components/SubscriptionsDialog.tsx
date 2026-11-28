/** Importing an OPML export and exporting the current subscriptions.
 *
 * The rail has no room to explain an import: the two strategies are a choice
 * with consequences, and a file picker is the first thing that has to happen.
 * So the flow lives in the app's own dialog — a numbered guide, a drop target
 * that says what it wants, the two strategies as described cards, and the
 * export beside them. */

import { useRef, useState } from '../react.js'
import {
  Button,
  IconCheckOutlineRegular,
  IconDownloadOutlineRegular,
  IconUploadOutlineRegular,
  IconWarningOutlineRegular,
  Modal,
  fileSizeText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientState, Controller } from '../types.js'
import type { Translate } from '../locales.js'

/** What the dialog needs from its opener. */
export interface SubscriptionsDialogProps {
  state: ClientState
  controller: Controller
  t: Translate
  onClose: () => void
}

/** One picked file, read as text once and held until the import runs. */
interface Picked {
  name: string
  text: string
  bytes: number
}

/**
 * The two strategies as described cards: one is a choice, and each says what it
 * does before it is pressed.
 */
function ModeCards({ t, count, replace, onReplace }: {
  t: Translate
  count: number
  replace: boolean
  onReplace: (value: boolean) => void
}) {
  return (
    <div className="gf-subs-modes" role="radiogroup" aria-label={t('subs.stepMode')}>
      <button
        type="button"
        role="radio"
        aria-checked={!replace}
        className={`gf-subs-mode${replace ? '' : ' on'}`}
        onClick={function () { onReplace(false) }}
      >
        <span className="gf-subs-mode-head">
          <IconCheckOutlineRegular size={14} />
          <span className="gf-subs-mode-name">{t('subs.merge')}</span>
          {replace ? null : <span className="gf-subs-badge">{t('subs.recommended')}</span>}
        </span>
        <span className="gf-subs-mode-hint">{t('subs.mergeHint')}</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={replace}
        className={`gf-subs-mode danger${replace ? ' on' : ''}`}
        onClick={function () { onReplace(true) }}
      >
        <span className="gf-subs-mode-head">
          <IconWarningOutlineRegular size={14} />
          <span className="gf-subs-mode-name">{t('subs.replace')}</span>
        </span>
        <span className="gf-subs-mode-hint">{t('subs.replaceHint', { n: count })}</span>
      </button>
    </div>
  )
}

/**
 * Step one: the file. A drop target that says what it wants, the browse button
 * inside it, and the file it now holds.
 */
export function FileStep({ t, busy, picked, onPick }: {
  t: Translate
  busy: boolean
  picked: Picked | null
  onPick: (picked: Picked | null) => void
}) {
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function take(file: File | null | undefined) {
    if (!file || busy) return
    try {
      onPick({ name: file.name, text: await file.text(), bytes: file.size })
    } catch {
      onPick(null)
    }
  }

  function browse() {
    if (fileRef.current) fileRef.current.click()
  }

  return (
    <section className="gf-subs-step">
      <h3 className="gf-subs-step-title">
        <span className="gf-subs-step-num" aria-hidden="true">1</span>
        {t('subs.stepFile')}
      </h3>
      <div
        className={`gf-subs-drop${dragging ? ' dragging' : ''}${picked ? ' picked' : ''}`}
        role="button"
        tabIndex={0}
        onClick={browse}
        onKeyDown={function (event: { key: string; preventDefault: () => void }) {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          browse()
        }}
        onDragOver={function (event: { preventDefault: () => void }) { event.preventDefault(); setDragging(true) }}
        onDragEnter={function (event: { preventDefault: () => void }) { event.preventDefault(); setDragging(true) }}
        onDragLeave={function (event: { preventDefault: () => void }) { event.preventDefault(); setDragging(false) }}
        onDrop={function (event: { preventDefault: () => void; dataTransfer?: { files?: FileList | null } | null }) {
          event.preventDefault()
          setDragging(false)
          void take(event.dataTransfer?.files?.[0])
        }}
      >
        <input
          ref={fileRef}
          className="gf-subs-file"
          type="file"
          accept=".opml,.xml,application/xml,text/xml,text/x-opml"
          aria-label={t('subs.stepFile')}
          onChange={function (event: { target: { files?: FileList | null; value: string } }) {
            const file = event.target.files ? event.target.files[0] : null
            // Clearing the field lets the same file be chosen again after a
            // failed import; the input's own value would keep it.
            event.target.value = ''
            void take(file)
          }}
        />
        {picked === null
          ? (
            <>
              <IconUploadOutlineRegular size={22} />
              <span className="gf-subs-drop-main">{t('subs.dropHint')}</span>
              <span className="gf-subs-drop-sub">{t('subs.browse')}</span>
            </>
          )
          : (
            <>
              <span className="gf-subs-file-name" title={picked.name}>{picked.name}</span>
              <span className="gf-subs-file-size">{fileSizeText(picked.bytes)}</span>
              <span className="gf-subs-file-change">{t('subs.changeFile')}</span>
            </>
          )}
      </div>
    </section>
  )
}

export function SubscriptionsDialog({ state, controller, t, onClose }: SubscriptionsDialogProps) {
  const [picked, setPicked] = useState<Picked | null>(null)
  const [replace, setReplace] = useState(false)

  const busyImport = state.busy.import
  const busyExport = state.busy.export
  const busy = busyImport || busyExport
  const count = state.feeds.length

  function close() {
    if (busy) return
    onClose()
  }

  async function submit() {
    if (!picked || busy) return
    const ok = await controller.importOpml(picked.text, replace)
    if (ok) onClose()
  }

  const action = busyImport
    ? t('subs.importing')
    : picked === null
      ? t('subs.chooseFirst')
      : replace
        ? t('subs.replaceAction', { n: count })
        : t('subs.mergeAction')

  return (
    <Modal
      open
      title={t('subs.title')}
      closeLabel={t('action.cancel')}
      description={t('subs.description')}
      onClose={close}
      className="gf-subs-dialog"
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={close}>{t('action.cancel')}</Button>
          <Button variant="primary" disabled={picked === null || busy} onClick={function () { void submit() }}>
            {action}
          </Button>
        </>
      )}
    >
      <div className="gf-subs">
        <FileStep t={t} busy={busy} picked={picked} onPick={setPicked} />

        <section className="gf-subs-step">
          <h3 className="gf-subs-step-title">
            <span className="gf-subs-step-num" aria-hidden="true">2</span>
            {t('subs.stepMode')}
          </h3>
          <ModeCards t={t} count={count} replace={replace} onReplace={setReplace} />
        </section>

        <section className="gf-subs-export">
          <div className="gf-subs-export-text">
            <h3 className="gf-subs-step-title">{t('subs.exportTitle')}</h3>
            <p className="gf-subs-export-hint">{t('subs.exportHint', { n: count })}</p>
          </div>
          <Button
            className="gf-subs-download"
            variant="outline"
            size="sm"
            icon={<IconDownloadOutlineRegular size={14} />}
            disabled={busy || count === 0}
            onClick={function () { void controller.exportOpml() }}
          >
            {busyExport ? t('subs.exporting') : t('subs.download')}
          </Button>
        </section>
      </div>
    </Modal>
  )
}
