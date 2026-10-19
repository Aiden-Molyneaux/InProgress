import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../parts/Button';
import { Chip } from '../parts/Chip';
import { Confirm } from '../parts/Confirm';
import { Field } from '../parts/Field';
import { useListCursor } from '../parts/ListCursor';
import { Menu, MenuItem, MenuSeparator } from '../parts/Menu';
import { Readout } from '../parts/Readout';
import { TabStrip } from '../parts/TabStrip';
import { Tile } from '../parts/Tile';
import { Toast, ToastRegion } from '../parts/Toast';
import { ALARM_TOAST_TEXT, CHIP_TEXT, CHIP_TONES, CURSOR_COLUMNS, MENU_ITEMS, PHASES, REMOVABLE_CHIPS, SAMPLE_BODY, SAMPLE_TITLE, SORTS, TOAST_TEXT } from './fixtures';
import { Cell, Section } from './Section';
import type { Cursor } from '../parts/listCursorLogic';

/** Every Chip tone, a dashed quiet one, and a row whose chips remove themselves (Reset brings them back). */
export function ChipSection() {
  const [chips, setChips] = useState(REMOVABLE_CHIPS);
  return (
    <Section name="Chip">
      <div className="lab-row">
        {CHIP_TONES.map((tone) => (
          <Cell key={tone} caption={`Tone ${tone}`}>
            <Chip tone={tone} glyph={tone === 'label' ? '⧉' : undefined}>
              {CHIP_TEXT[tone]}
            </Chip>
          </Cell>
        ))}
        <Cell caption="Quiet, dashed">
          <Chip dashed>Quiet</Chip>
        </Cell>
      </div>
      <div className="lab-row">
        <Cell caption="Removable">
          <span className="lab-inline">
            {chips.map((name) => (
              <Chip key={name} onRemove={() => setChips((now) => now.filter((c) => c !== name))}>
                {name}
              </Chip>
            ))}
            {chips.length === 0 && <span className="lab-cap">All removed.</span>}
          </span>
        </Cell>
        <Cell caption="Restore the removable chips">
          <Button variant="ghost" size="sm" onClick={() => setChips(REMOVABLE_CHIPS)}>
            Reset
          </Button>
        </Cell>
      </div>
    </Section>
  );
}

/** A tabs strip with a panel line, a segmented strip, and the tabs again in a narrow box. */
export function TabStripSection() {
  const [phase, setPhase] = useState(PHASES[0].id);
  const [sort, setSort] = useState(SORTS[0].id);
  // The narrow strip is the same tabs under other ids, so no id is on the page twice.
  const narrow = useMemo(() => PHASES.map((p) => ({ ...p, id: `narrow-${p.id}` })), []);
  const shown = PHASES.find((p) => p.id === phase)?.label;
  return (
    <Section name="TabStrip">
      <Cell caption="Tabs, eight phases, state held by the page">
        <TabStrip label="Lab tabs" items={PHASES} value={phase} onChange={setPhase} />
      </Cell>
      <p className="lab-panel">Showing {shown}</p>
      <Cell caption="Segmented">
        <TabStrip variant="segmented" label="Sort" items={SORTS} value={sort} onChange={setSort} />
      </Cell>
      <Cell caption="Tabs in a narrow box: the strip scrolls and keeps the selected tab in view" className="lab-narrow">
        <TabStrip label="Narrow tabs" items={narrow} value={`narrow-${phase}`} onChange={(id) => setPhase(id.replace('narrow-', ''))} />
      </Cell>
    </Section>
  );
}

/** Field sizes and states. */
export function FieldSection() {
  return (
    <Section name="Field">
      <div className="lab-row">
        <Cell caption="Small, with a label">
          <Field size="sm" label="Step name" defaultValue="Sign the build" />
        </Cell>
        <Cell caption="Medium, with a label">
          <Field label="Step name" defaultValue="Sign the build" />
        </Cell>
        <Cell caption="Only an aria-label">
          <Field aria-label="Search" placeholder="Search steps" />
        </Cell>
        <Cell caption="With a hint">
          <Field label="Go to" placeholder="Type a step name" hint="Ctrl K" />
        </Cell>
        <Cell caption="Invalid, with a reason">
          <Field label="Hue" defaultValue="9" invalid="A hue is a number from 0 to 6." />
        </Cell>
        <Cell caption="Busy">
          <Field label="Step name" defaultValue="Saving this name" busy />
        </Cell>
        <Cell caption="Disabled">
          <Field label="Step name" defaultValue="Locked" disabled />
        </Cell>
        <Cell caption="A textarea that grows with its text">
          <Field label="Note" multiline defaultValue="Type here and the box grows." />
        </Cell>
      </div>
    </Section>
  );
}

/** A static menu with every item state, and a button that opens one below it. */
export function MenuSection() {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    opener.current?.focus();
  };
  const items = (
    <>
      {MENU_ITEMS.map((item) => (
        <Fragment key={item.label}>
          {item.separatorBefore && <MenuSeparator />}
          <MenuItem glyph={item.glyph} keyHint={item.keyHint} current={item.current} danger={item.danger} disabled={item.disabled} onSelect={close}>
            {item.label}
          </MenuItem>
        </Fragment>
      ))}
    </>
  );
  return (
    <Section name="Menu">
      <div className="lab-row">
        <Cell caption="Static: head, glyphs, key hints, a current item, a separator, a danger item and a disabled item">
          <Menu head="Step actions">{items}</Menu>
        </Cell>
        <Cell caption="Opened from a button: Escape or choosing an item closes it and returns focus" className="lab-pop" >
          <Button ref={opener} glyph="›" onClick={() => setOpen((now) => !now)} aria-expanded={open}>
            Open menu
          </Button>
          {open && (
            <div className="lab-pop-menu">
              <Menu label="Step actions" autoFocus onClose={close}>
                {items}
              </Menu>
            </div>
          )}
        </Cell>
      </div>
    </Section>
  );
}

/** Two Confirms, and a button that swaps itself for a live one. */
export function ConfirmSection() {
  const [asking, setAsking] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const back = useRef(false);
  // Focus goes back to the button once it is on the page again.
  useEffect(() => {
    if (!asking && back.current) {
      back.current = false;
      opener.current?.focus();
    }
  }, [asking]);
  const leave = () => {
    back.current = true;
    setAsking(false);
  };
  return (
    <Section name="Confirm">
      <div className="lab-row">
        <Cell caption="Danger">
          <Confirm danger focusOnMount={false} question="Delete this step?" detail="Its notes and resources go with it." action="Delete step" onConfirm={() => undefined} onCancel={() => undefined} />
        </Cell>
        <Cell caption="Plain">
          <Confirm focusOnMount={false} question="Move this step to Backlog?" action="Move" onConfirm={() => undefined} onCancel={() => undefined} />
        </Cell>
        <Cell caption="Live: focus goes to Cancel, and back to the button after">
          {asking ? (
            <Confirm danger question="Delete this step?" detail="Its notes and resources go with it." action="Delete step" onConfirm={leave} onCancel={leave} />
          ) : (
            <Button ref={opener} variant="danger" onClick={() => setAsking(true)}>
              Delete step
            </Button>
          )}
        </Cell>
      </div>
    </Section>
  );
}

/** Every Tile tone and state. */
export function TileSection() {
  return (
    <Section name="Tile">
      <div className="lab-tiles">
        <Cell caption="Default, with a hue, id, chips and a foot">
          <Tile
            hue={0}
            id="#142"
            chips={
              <>
                <Chip tone="ready">Ready</Chip>
                <Chip tone="count">3</Chip>
              </>
            }
            title={SAMPLE_TITLE}
            body={SAMPLE_BODY}
            foot={<Chip tone="label" glyph="⧉">ui</Chip>}
            actions={<Button variant="ghost" size="sm">Open</Button>}
          />
        </Cell>
        <Cell caption="Ask, with an answer field">
          <Tile
            hue={5}
            tone="ask"
            id="#143"
            chips={<Chip tone="needs">Needs you</Chip>}
            title="Which keystore signs the release?"
            body={
              <div className="lab-answer">
                <Field size="sm" aria-label="Your answer" placeholder="Your answer" />
                <Button variant="primary" size="sm">
                  Send
                </Button>
              </div>
            }
          />
        </Cell>
        <Cell caption="Done">
          <Tile tone="done" id="#120" title="Upload the keystore" body={SAMPLE_BODY} />
        </Cell>
        <Cell caption="Parked">
          <Tile tone="parked" id="#121" chips={<Chip tone="parked">Parked</Chip>} title="Translate the store listing" />
        </Cell>
        <Cell caption="Selected">
          <Tile hue={3} id="#144" title={SAMPLE_TITLE} selected />
        </Cell>
        <Cell caption="Dragging">
          <Tile hue={2} id="#145" title={SAMPLE_TITLE} dragging />
        </Cell>
        <Cell caption="Drop line above">
          <Tile hue={1} id="#146" title={SAMPLE_TITLE} dropBefore />
        </Cell>
        <Cell caption="Pending: dimmed, actions hidden">
          <Tile hue={4} id="#147" title={SAMPLE_TITLE} pending actions={<Button variant="ghost" size="sm">Open</Button>} foot={<Chip>Saving</Chip>} />
        </Cell>
      </div>
    </Section>
  );
}

/** A neutral and an alarm toast as specimens, and a button that shows a real one in a mounted region. */
export function ToastSection() {
  const [shown, setShown] = useState(0);
  return (
    <Section name="Toast">
      <div className="lab-row">
        <Cell caption="Neutral">
          <Toast>{TOAST_TEXT}</Toast>
        </Cell>
        <Cell caption="Alarm">
          <Toast tone="alarm">{ALARM_TOAST_TEXT}</Toast>
        </Cell>
        <Cell caption="Alarm, with its dismiss button">
          <Toast tone="alarm" onDismiss={() => undefined}>
            {ALARM_TOAST_TEXT}
          </Toast>
        </Cell>
        <Cell caption="A real toast, gone after four seconds">
          <Button onClick={() => setShown((n) => n + 1)}>Show toast</Button>
        </Cell>
      </div>
      <ToastRegion>
        {shown > 0 && (
          <Toast key={shown} onDismiss={() => setShown(0)}>
            {TOAST_TEXT}
          </Toast>
        )}
      </ToastRegion>
    </Section>
  );
}

/** The counts of the cursor grid's columns, held still so the hook's callbacks do not change on every render. */
const COUNTS = CURSOR_COLUMNS.map((column) => column.length);

/** A grid of plain tiles walked with the arrow keys as one Tab stop; Enter shows which one opened. */
export function ListCursorSection() {
  const [opened, setOpened] = useState('none');
  const open = (at: Cursor) => setOpened(CURSOR_COLUMNS[at.col][at.row].id);
  const { itemProps } = useListCursor(COUNTS, open);
  return (
    <Section name="ListCursor">
      <Cell caption="Arrows walk across and down, Enter opens, Tab leaves the grid in one stop">
        <div className="lab-grid">
          {CURSOR_COLUMNS.map((column, col) => (
            <div key={col} className="lab-col">
              {column.map((item, row) => (
                <Tile key={item.id} id={item.id} title={item.title} onOpen={() => setOpened(item.id)} {...itemProps(col, row)} />
              ))}
            </div>
          ))}
        </div>
      </Cell>
      <Readout label="OPENED" value={opened} />
    </Section>
  );
}
