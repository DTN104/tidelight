// One input path for humans (mouse + touch) and the scripted capture cursor.
// move/down/up take viewport (CSS pixel) coordinates.
export class Input {
  constructor(game, world) {
    this.game = game;
    this.world = world;
    this.reset();
  }

  reset() {
    this.x = null;
    this.y = null;
    this.isDown = false;
    this.downT = 0;
    this.downX = 0;
    this.downY = 0;
    this.moved = false;
    this.aimActive = false;
    this.lastDownT = -10;
    this.lastUpT = -10;
    this.pointerType = 'mouse';
  }

  move(x, y) {
    this.x = x;
    this.y = y;
    if (this.isDown && Math.hypot(x - this.downX, y - this.downY) > 14) this.moved = true;
    if (this.pointerType !== 'touch' || this.isDown) this.aimActive = true;
  }

  down(x, y, type = 'mouse') {
    this.pointerType = type;
    this.isDown = true;
    this.x = x;
    this.y = y;
    this.downX = x;
    this.downY = y;
    this.moved = false;
    this.downT = this.game.t;
    this.lastDownT = this.game.t;
    this.aimActive = true;
  }

  up(x, y) {
    if (!this.isDown) return;
    this.isDown = false;
    this.lastUpT = this.game.t;
    if (x != null) {
      this.x = x;
      this.y = y;
    }
    if (!this.moved && this.game.t - this.downT < 0.45) {
      this.game.tap(this.world.screenToWater(this.x, this.y));
    }
  }

  // Called every simulation step: the pointer drives the beam.
  apply() {
    if (this.aimActive && this.x != null) {
      const p = this.world.screenToWater(this.x, this.y);
      this.game.setAim(p.x, p.z);
    }
  }

  attach(el) {
    const opts = { passive: false };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (el.setPointerCapture) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch (err) {
          /* ignore */
        }
      }
      this.down(e.clientX, e.clientY, e.pointerType);
    }, opts);
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' && !this.isDown) return;
      this.move(e.clientX, e.clientY);
    }, opts);
    const end = (e) => this.up(e.clientX, e.clientY);
    el.addEventListener('pointerup', end, opts);
    el.addEventListener('pointercancel', () => {
      this.isDown = false;
      this.moved = true;
    }, opts);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('touchmove', (e) => e.preventDefault(), opts);
  }
}
