// Fenstersteuerung in der Tile, nachgebaut nach Kevins Hyprland-Master-Layout.
// "Fenster" sind die Webview, das Agents-Panel und jede Terminal-Pane. Befehle kommen per Hyprland-Taste
// (keys/agent-keys.pyw → ~/.cache/agent-tile/wm) und heißen wie die Hyprland-Dispatcher.

const WM_GAP = 12;
const WM_STRIP = 44; // eingeklappter Web-Chat
const WM_PANEL_UP_FROM = 3; // ab so vielen Terminals im Stapel rückt das Panel unter den Master
const WM_MIN = 80; // kleinste Höhe/Breite beim Vergrößern
const WM_ORIENTATIONS = ["left", "top", "right", "bottom"]; // Reihenfolge wie orientationnext

const wm = {
  root: null, // #tiles
  placeholder: null, // "Keine Session offen" als Platzhalter im Stapel
  windows: new Map(), // id → { el, weight, fixed: null | px, floating: null | {x, y, w, h} }
  order: [], // Master zuerst, dann der Stapel (wie in Hyprland)
  focused: null,
  fullscreen: null,
  collapsed: null, // id des eingeklappten Fensters (nur der Web-Chat)
  onFocus: () => {}, // Renderer gibt dem Fenster den Tastaturfokus
  onLayout: () => {}, // Renderer passt Terminals an
  settings: { mfact: 0.5, nmaster: 1, orientation: "left", mode: "master" },

  init({ root, placeholder, onFocus, onLayout }) {
    Object.assign(this, { root, placeholder, onFocus, onLayout });
    try {
      Object.assign(this.settings, JSON.parse(localStorage.getItem("wm") || "{}"));
    } catch {}
    new ResizeObserver(() => this.layout()).observe(root);
    this.enableGapResize();
  },

  save() {
    try {
      localStorage.setItem("wm", JSON.stringify(this.settings));
    } catch {}
  },

  // Neue Fenster kommen ans Ende des Stapels (master.new_status = "slave") —
  // steht das Panel ganz unten, bleibt es dort und neue Fenster kommen darüber.
  // fixed: feste Höhe/Breite in px statt Anteil (Panel: 318 wie im Mockup)
  add(id, el, { fixed = null } = {}) {
    this.windows.set(id, { el, weight: 1, fixed, floating: null });
    if (this.order.at(-1) === "panel") this.order.splice(this.order.length - 1, 0, id);
    else this.order.push(id);
    if (!el.classList.contains("win")) {
      el.classList.add("win");
      el.addEventListener("mousedown", () => this.setFocused(id));
      this.enableCornerResize(id, el);
    }
    this.layout();
  },

  remove(id) {
    this.windows.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.fullscreen === id) this.fullscreen = null;
    if (this.focused === id) this.focus(this.order.find((x) => this.isVisible(x)) ?? null);
    this.layout();
  },

  isVisible(id) {
    return this.windows.has(id) && id !== this.collapsed;
  },

  setCollapsed(id, collapsed) {
    this.collapsed = collapsed ? id : this.collapsed === id ? null : this.collapsed;
    this.windows.get(id)?.el.classList.toggle("collapsed", collapsed);
    if (collapsed && this.focused === id) this.focus(this.order.find((x) => this.isVisible(x)) ?? null);
    this.layout();
  },

  // Fokus nur merken (Klick, Fokus-Event aus dem Fenster) …
  setFocused(id) {
    if (this.focused === id) return;
    this.focused = id;
    for (const [wid, w] of this.windows) w.el.classList.toggle("focused", wid === id);
    if (this.settings.mode === "monocle") this.layout();
  },

  // … oder auch den Tastaturfokus hingeben (Befehle)
  focus(id) {
    this.setFocused(id);
    if (id) this.onFocus(id);
  },

  // --- Layout ------------------------------------------------------------------

  tiled() {
    return this.order.filter((id) => this.isVisible(id) && !this.windows.get(id).floating);
  },

  place(el, box, z = "") {
    Object.assign(el.style, {
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${Math.max(0, box.w)}px`,
      height: `${Math.max(0, box.h)}px`,
      zIndex: z,
    });
    el.hidden = false;
  },

  // Fenster untereinander (vertical) bzw. nebeneinander, Lücke WM_GAP.
  // Feste Größen zuerst, der Rest wird nach weight verteilt.
  split(ids, box, vertical) {
    const win = (id) => this.windows.get(id) ?? { weight: 1, fixed: null };
    const space = (vertical ? box.h : box.w) - WM_GAP * (ids.length - 1);
    const flexible = ids.filter((id) => !win(id).fixed);
    const fixedTotal = ids.reduce((sum, id) => sum + (win(id).fixed ?? 0), 0);
    // Reicht der Platz nicht (oder gibt es nur feste Fenster), werden die festen gestaucht
    let scale = 1;
    if (fixedTotal && !flexible.length) scale = space / fixedTotal;
    else if (fixedTotal) scale = Math.max(0, Math.min(1, (space - WM_MIN * flexible.length) / fixedTotal));
    const rest = space - fixedTotal * scale;
    const weights = flexible.reduce((sum, id) => sum + win(id).weight, 0);
    let offset = 0;
    for (const id of ids) {
      const w = win(id);
      const size = w.fixed ? w.fixed * scale : (rest * w.weight) / weights;
      const part = vertical
        ? { x: box.x, y: box.y + offset, w: box.w, h: size }
        : { x: box.x + offset, y: box.y, w: size, h: box.h };
      this.place(id === "placeholder" ? this.placeholder : this.windows.get(id).el, part);
      offset += size + WM_GAP;
    }
  },

  layout() {
    if (!this.root) return;
    const { mfact, nmaster, orientation, mode } = this.settings;
    let area = { x: 0, y: 0, w: this.root.clientWidth, h: this.root.clientHeight };
    this.placeholder.hidden = true;

    // Eingeklappter Web-Chat: schmaler Streifen links
    if (this.collapsed) {
      this.place(this.windows.get(this.collapsed).el, { x: 0, y: 0, w: WM_STRIP, h: area.h });
      area = { ...area, x: WM_STRIP + WM_GAP, w: area.w - WM_STRIP - WM_GAP };
    }

    const tiled = this.tiled();
    for (const id of this.order) if (this.isVisible(id)) this.windows.get(id).el.hidden = false;

    if (mode === "monocle") {
      // Ein Fenster füllt die Fläche (das fokussierte, sonst das erste)
      const shown = tiled.includes(this.focused) ? this.focused : tiled[0];
      for (const id of tiled) if (id !== shown) this.windows.get(id).el.hidden = true;
      if (shown) this.place(this.windows.get(shown).el, area);
    } else {
      const masters = tiled.slice(0, Math.max(1, nmaster));
      let stack = tiled.slice(masters.length);
      const isPane = (id) => id !== "web" && id !== "panel";

      // Ohne Terminals steht im Stapel der Platzhalter (Raster wie im Mockup)
      if (!tiled.some(isPane) && tiled.includes("web")) stack = ["placeholder", ...stack];
      // Ab WM_PANEL_UP_FROM Terminals im Stapel rückt das Panel unter den Master
      if (stack.includes("panel") && stack.filter(isPane).length >= WM_PANEL_UP_FROM) {
        stack = stack.filter((id) => id !== "panel");
        masters.push("panel");
      }

      const vertical = orientation === "left" || orientation === "right";
      if (!stack.length) {
        this.split(masters, area, vertical);
      } else if (vertical) {
        const masterW = Math.round((area.w - WM_GAP) * mfact);
        const stackW = area.w - WM_GAP - masterW;
        const masterX = orientation === "left" ? area.x : area.x + stackW + WM_GAP;
        const stackX = orientation === "left" ? area.x + masterW + WM_GAP : area.x;
        this.split(masters, { x: masterX, y: area.y, w: masterW, h: area.h }, true);
        this.split(stack, { x: stackX, y: area.y, w: stackW, h: area.h }, true);
      } else {
        const masterH = Math.round((area.h - WM_GAP) * mfact);
        const stackH = area.h - WM_GAP - masterH;
        const masterY = orientation === "top" ? area.y : area.y + stackH + WM_GAP;
        const stackY = orientation === "top" ? area.y + masterH + WM_GAP : area.y;
        this.split(masters, { x: area.x, y: masterY, w: area.w, h: masterH }, false);
        this.split(stack, { x: area.x, y: stackY, w: area.w, h: stackH }, false);
      }
    }

    // Schwebende Fenster über allem, Vollbild ganz oben
    for (const id of this.order) {
      const w = this.windows.get(id);
      if (w.floating && this.isVisible(id)) this.place(w.el, w.floating, 20);
    }
    if (this.fullscreen && this.isVisible(this.fullscreen)) {
      this.place(this.windows.get(this.fullscreen).el, { x: 0, y: 0, w: this.root.clientWidth, h: this.root.clientHeight }, 30);
    }

    this.onLayout();
  },

  // --- Befehle (Namen wie die Hyprland-Dispatcher) -----------------------------

  rect(id) {
    return this.windows.get(id).el.getBoundingClientRect();
  },

  // Nächstes sichtbares Fenster in einer Richtung, nach Mittelpunkten (wie focus direction)
  neighbor(id, dir) {
    if (!id) return null;
    const from = this.rect(id);
    const fx = from.x + from.width / 2;
    const fy = from.y + from.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const other of this.order) {
      if (other === id || !this.isVisible(other) || this.windows.get(other).el.hidden) continue;
      const r = this.rect(other);
      const dx = r.x + r.width / 2 - fx;
      const dy = r.y + r.height / 2 - fy;
      const along = { left: -dx, right: dx, up: -dy, down: dy }[dir];
      if (along <= 0) continue;
      const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
      const score = along + 2 * across;
      if (score < bestScore) [best, bestScore] = [other, score];
    }
    return best;
  },

  swap(a, b) {
    const i = this.order.indexOf(a);
    const j = this.order.indexOf(b);
    [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
  },

  visibleOrder() {
    return this.order.filter((id) => this.isVisible(id));
  },

  command(line) {
    const [name, ...args] = line.trim().split(/\s+/);
    const id = this.focused;
    const w = id && this.windows.get(id);
    const s = this.settings;

    switch (name) {
      case "focus": {
        if (s.mode === "monocle") return this.cycle(args[0] === "left" || args[0] === "up" ? -1 : 1);
        const next = this.neighbor(id, args[0]) ?? (id ? null : this.visibleOrder()[0]);
        if (next) this.focus(next);
        return;
      }
      case "move": {
        if (!w) return;
        if (w.floating) {
          const step = { left: [-40, 0], right: [40, 0], up: [0, -40], down: [0, 40] }[args[0]];
          w.floating.x += step[0];
          w.floating.y += step[1];
          return this.layout();
        }
        const other = this.neighbor(id, args[0]);
        if (other && !this.windows.get(other).floating) {
          this.swap(id, other);
          this.layout();
        }
        return;
      }
      case "resize":
        return w && this.resize(id, Number(args[0]), Number(args[1]));
      case "swapwithmaster": {
        const tiled = this.tiled();
        if (!w || w.floating || tiled.length < 2) return;
        const partner = id === tiled[0] ? tiled[1] : tiled[0];
        this.swap(id, partner);
        this.layout();
        return this.focus(this.tiled()[0]);
      }
      case "cyclenext":
        return this.cycle(1);
      case "addmaster":
        s.nmaster = Math.min(s.nmaster + 1, Math.max(1, this.tiled().length - 1));
        break;
      case "removemaster":
        s.nmaster = Math.max(1, s.nmaster - 1);
        break;
      case "orientationnext":
        s.orientation = WM_ORIENTATIONS[(WM_ORIENTATIONS.indexOf(s.orientation) + 1) % WM_ORIENTATIONS.length];
        break;
      case "layout":
        s.mode = args[0] === "monocle" ? "monocle" : "master";
        break;
      case "float": {
        if (!w) return;
        if (w.floating) w.floating = null;
        else {
          const W = this.root.clientWidth;
          const H = this.root.clientHeight;
          w.floating = { x: Math.round(W * 0.2), y: Math.round(H * 0.15), w: Math.round(W * 0.6), h: Math.round(H * 0.7) };
        }
        w.el.classList.toggle("floating", Boolean(w.floating));
        return this.layout();
      }
      case "fullscreen":
        if (!w) return;
        this.fullscreen = this.fullscreen === id ? null : id;
        return this.layout();
      case "close":
        return id && this.onClose(id);
      default:
        return;
    }
    this.save();
    this.layout();
  },

  cycle(step) {
    const ids = this.visibleOrder();
    if (!ids.length) return;
    const i = ids.indexOf(this.focused);
    this.focus(ids[(i + step + ids.length) % ids.length]);
  },

  // resize x y wie in Hyprland: Breite/Höhe des fokussierten Fensters um x/y Pixel
  resize(id, dx, dy) {
    const w = this.windows.get(id);
    if (w.floating) {
      w.floating.w = Math.max(WM_MIN * 2, w.floating.w + dx);
      w.floating.h = Math.max(WM_MIN, w.floating.h + dy);
      return this.layout();
    }
    const s = this.settings;
    const tiled = this.tiled();
    const isMaster = tiled.indexOf(id) < Math.max(1, s.nmaster);
    const vertical = s.orientation === "left" || s.orientation === "right";
    const along = vertical ? dx : dy; // verschiebt die Grenze Master/Stapel
    const across = vertical ? dy : dx; // verteilt innerhalb der Spalte
    const extent = vertical ? this.root.clientWidth : this.root.clientHeight;

    if (along) {
      const delta = along / extent;
      s.mfact = Math.min(0.9, Math.max(0.1, s.mfact + (isMaster ? delta : -delta)));
      this.save();
    }
    if (across) {
      const r = this.rect(id);
      const size = vertical ? r.height : r.width;
      if (w.fixed) w.fixed = Math.max(WM_MIN, size + across);
      else w.weight *= Math.max(WM_MIN, size + across) / size;
    }
    this.layout();
  },

  onClose: () => {}, // Renderer: Terminal ausblenden bzw. Web-Chat einklappen

  // --- Größe per Maus ----------------------------------------------------------
  // Die Lücke zwischen zwei Fenstern ziehen: zwischen Master und Stapel verschiebt sie mfact,
  // zwischen zwei Fenstern derselben Spalte/Zeile tauscht sie Platz nur zwischen diesen beiden.

  // Fenster links/oberhalb (a) und rechts/unterhalb (b) der Lücke unter dem Mauszeiger, sonst null
  gapAt(x, y) {
    const tol = WM_GAP + 3;
    const boxes = this.tiled()
      .filter((id) => !this.windows.get(id).el.hidden)
      .map((id) => ({ id, r: this.rect(id) }));
    const find = (vertical) => {
      const pos = vertical ? x : y;
      const cross = vertical ? y : x;
      const inCross = (r) => (vertical ? r.top <= cross && cross <= r.bottom : r.left <= cross && cross <= r.right);
      const a = boxes.find(({ r }) => inCross(r) && (vertical ? r.right : r.bottom) <= pos && pos - (vertical ? r.right : r.bottom) < tol);
      const b = boxes.find(({ r }) => inCross(r) && (vertical ? r.left : r.top) >= pos && (vertical ? r.left : r.top) - pos < tol);
      return a && b ? { a: a.id, b: b.id, vertical } : null;
    };
    return find(true) ?? find(false);
  },

  enableGapResize() {
    const root = this.root;
    root.addEventListener("mousemove", (e) => {
      if (e.target !== root || root.classList.contains("wm-resizing")) return;
      const gap = this.settings.mode === "master" && this.gapAt(e.clientX, e.clientY);
      root.style.cursor = gap ? (gap.vertical ? "col-resize" : "row-resize") : "";
    });
    root.addEventListener("mousedown", (down) => {
      if (down.target !== root || down.button !== 0 || this.settings.mode !== "master") return;
      const gap = this.gapAt(down.clientX, down.clientY);
      if (!gap) return;
      down.preventDefault();
      const s = this.settings;
      const layoutVertical = s.orientation === "left" || s.orientation === "right";
      // Lücke quer zur Master-Achse = Grenze Master/Stapel, sonst zwei Nachbarn in derselben Spalte
      const boundary = gap.vertical === layoutVertical;
      const extent = layoutVertical ? this.root.clientWidth : this.root.clientHeight;
      const start = { pos: gap.vertical ? down.clientX : down.clientY, mfact: s.mfact };
      const a = this.windows.get(gap.a);
      const b = this.windows.get(gap.b);
      const sizeOf = (id) => (gap.vertical ? this.rect(id).width : this.rect(id).height);
      const startA = { size: sizeOf(gap.a), weight: a.weight, fixed: a.fixed };
      const startB = { size: sizeOf(gap.b), weight: b.weight, fixed: b.fixed };
      const masterFirst = s.orientation === "left" || s.orientation === "top";

      root.classList.add("wm-resizing");
      root.style.cursor = gap.vertical ? "col-resize" : "row-resize";
      let frame = 0;
      const move = (e) => {
        const delta = (gap.vertical ? e.clientX : e.clientY) - start.pos;
        if (boundary) {
          s.mfact = Math.min(0.9, Math.max(0.1, start.mfact + ((masterFirst ? 1 : -1) * delta) / extent));
        } else {
          const d = Math.max(WM_MIN - startA.size, Math.min(startB.size - WM_MIN, delta));
          if (startA.fixed) a.fixed = startA.size + d;
          if (startB.fixed) b.fixed = startB.size - d;
          if (!startA.fixed && !startB.fixed) {
            // Gewichte der beiden so verteilen, dass ihre Summe (und damit alle anderen) gleich bleibt
            const total = startA.weight + startB.weight;
            a.weight = (total * (startA.size + d)) / (startA.size + startB.size);
            b.weight = total - a.weight;
          }
        }
        if (!frame) frame = requestAnimationFrame(() => {
          frame = 0;
          this.layout();
        });
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        root.classList.remove("wm-resizing");
        root.style.cursor = "";
        this.save();
        this.layout();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  },

  // Schwebende Fenster: unten rechts an der Ecke ziehen
  enableCornerResize(id, el) {
    const corner = document.createElement("div");
    corner.className = "wm-corner";
    el.append(corner);
    corner.addEventListener("mousedown", (down) => {
      const w = this.windows.get(id);
      if (!w?.floating || down.button !== 0) return;
      down.preventDefault();
      down.stopPropagation();
      const start = { w: w.floating.w, h: w.floating.h, mx: down.clientX, my: down.clientY };
      this.root.classList.add("wm-resizing");
      const move = (e) => {
        w.floating.w = Math.max(WM_MIN * 2, start.w + e.clientX - start.mx);
        w.floating.h = Math.max(WM_MIN, start.h + e.clientY - start.my);
        this.place(w.el, w.floating, 20);
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        this.root.classList.remove("wm-resizing");
        this.onLayout();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  },

  // Schwebende Fenster an der Kopfzeile ziehen
  enableDrag(id, handle) {
    handle.addEventListener("mousedown", (down) => {
      const w = this.windows.get(id);
      if (!w?.floating || down.target.closest("button")) return;
      const start = { ...w.floating, mx: down.clientX, my: down.clientY };
      const move = (e) => {
        w.floating.x = start.x + e.clientX - start.mx;
        w.floating.y = start.y + e.clientY - start.my;
        this.place(w.el, w.floating, 20);
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        this.onLayout();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  },
};
