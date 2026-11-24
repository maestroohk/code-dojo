// Pointer-based drag and drop (works with mouse, touch and pen), plus a token board
// used by the blanks, match and sort exercises. Every drag also has a tap equivalent.

/**
 * enableDrag(root, { item, zone, onStart, onMove, onDrop, onTap })
 *   item / zone  CSS selectors inside root
 *   onMove(item, zoneOrNull, event), onDrop(item, zoneOrNull, event), onTap(item)
 */
export function enableDrag(root, opts) {
  root.addEventListener('pointerdown', e => {
    if (e.button !== 0 || root.dataset.locked) return;
    const item = e.target.closest(opts.item);
    if (!item || !root.contains(item) || e.target.closest('[data-nodrag]')) return;

    const start = { x: e.clientX, y: e.clientY };
    const rect = item.getBoundingClientRect();
    let ghost = null, hot = null;

    const zoneAt = (x, y) => {
      const under = document.elementFromPoint(x, y);
      const zone = under && opts.zone ? under.closest(opts.zone) : null;
      return zone && root.contains(zone) ? zone : null;
    };
    const setHot = zone => {
      if (hot === zone) return;
      hot?.classList.remove('drop-hot');
      hot = zone;
      hot?.classList.add('drop-hot');
    };
    const move = ev => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
        ghost = item.cloneNode(true);
        ghost.classList.add('drag-ghost');
        ghost.style.width = rect.width + 'px';
        ghost.style.height = rect.height + 'px';
        document.body.append(ghost);
        item.classList.add('dragging');
        document.body.classList.add('is-dragging');
        opts.onStart?.(item);
      }
      ghost.style.transform = `translate(${rect.left + ev.clientX - start.x}px, ${rect.top + ev.clientY - start.y}px) rotate(1.5deg)`;
      const zone = zoneAt(ev.clientX, ev.clientY);
      setHot(zone);
      opts.onMove?.(item, zone, ev);
    };
    const finish = (ev, cancelled) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      const dragged = !!ghost;
      ghost?.remove();
      item.classList.remove('dragging');
      document.body.classList.remove('is-dragging');
      setHot(null);
      if (cancelled) return;
      if (!dragged) opts.onTap?.(item, ev);
      else opts.onDrop?.(item, zoneAt(ev.clientX, ev.clientY), ev);
    };
    const up = ev => finish(ev, false);
    const cancel = ev => finish(ev, true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    e.preventDefault();
  });
}

/**
 * A set of chips that live either in a bank or in zones.
 *   tokens: [{ id, el }]            el is the chip element (gets data-token)
 *   zones:  [{ id, el, capacity }]  el is where chips are appended; capacity 1 = a slot
 *   bank:   element holding unplaced chips
 */
export class Board {
  constructor(root, { tokens, zones, bank, onChange }) {
    this.root = root;
    this.tokens = new Map(tokens.map(t => [t.id, t]));
    this.zones = new Map(zones.map(z => [z.id, z]));
    this.bank = bank;
    this.onChange = onChange || (() => {});
    this.where = new Map(tokens.map(t => [t.id, null]));
    this.selected = null;

    for (const t of tokens) { t.el.dataset.token = t.id; t.el.classList.add('chip'); bank.append(t.el); }
    for (const z of zones) { z.el.dataset.zone = z.id; z.el.classList.add('zone'); }
    bank.dataset.zone = '';
    bank.classList.add('zone', 'bank');

    enableDrag(root, {
      item: '.chip',
      zone: '.zone',
      onDrop: (el, zoneEl) => this.place(el.dataset.token, zoneEl ? (zoneEl.dataset.zone || null) : null),
      onTap: el => this.tap(el.dataset.token),
    });
    // Tap-to-place for multi-capacity zones: select a chip, then tap a bucket.
    root.addEventListener('click', e => {
      if (root.dataset.locked || this.selected == null || e.target.closest('.chip')) return;
      const zoneEl = e.target.closest('.zone');
      if (zoneEl && zoneEl.dataset.zone) this.place(this.selected, zoneEl.dataset.zone);
    });
  }

  occupants(zoneId) { return [...this.where].filter(([, z]) => z === zoneId).map(([t]) => t); }
  get allPlaced() { return [...this.where.values()].every(z => z !== null); }
  get slotsFilled() { return [...this.zones.values()].every(z => z.capacity !== 1 || this.occupants(z.id).length === 1); }

  select(tokenId) {
    if (this.selected != null) this.tokens.get(this.selected)?.el.classList.remove('selected');
    this.selected = tokenId;
    if (tokenId != null) this.tokens.get(tokenId).el.classList.add('selected');
  }

  tap(tokenId) {
    const at = this.where.get(tokenId);
    if (at !== null) return this.place(tokenId, null);
    const empty = [...this.zones.values()].find(z => z.capacity === 1 && this.occupants(z.id).length === 0);
    if (empty) return this.place(tokenId, empty.id);
    this.select(this.selected === tokenId ? null : tokenId);
  }

  place(tokenId, zoneId, silent) {
    const from = this.where.get(tokenId);
    const zone = zoneId == null ? null : this.zones.get(zoneId);
    if (zone && zone.capacity === 1) {
      // Swap with whatever sits in the slot already.
      for (const other of this.occupants(zone.id)) if (other !== tokenId) this.move(other, from !== null && this.zones.get(from)?.capacity === 1 ? from : null);
    }
    this.move(tokenId, zone ? zone.id : null);
    this.select(null);
    if (!silent) this.onChange();
  }

  move(tokenId, zoneId) {
    this.where.set(tokenId, zoneId);
    const el = this.tokens.get(tokenId).el;
    el.classList.remove('right', 'wrong');
    (zoneId == null ? this.bank : this.zones.get(zoneId).el).append(el);
    for (const z of this.zones.values()) z.el.classList.toggle('filled', this.occupants(z.id).length > 0);
  }

  clearMarks() {
    for (const t of this.tokens.values()) t.el.classList.remove('right', 'wrong');
    for (const z of this.zones.values()) z.el.classList.remove('right', 'wrong');
  }
}
