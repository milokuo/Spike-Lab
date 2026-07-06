// A DOM element that plays a CSS "show" animation for durationMs then
// auto-hides. Reused across the HUD's feedback popups (grade, dive/illegal
// touch, player-left notice, score banner) so each doesn't hand-roll the same
// remove/reflow/add/timeout dance. The forced reflow before re-adding the show
// class guarantees the animation restarts on every call, even back-to-back.
export class TransientPopup {
  private timeoutId: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly element: HTMLElement,
    private readonly showClass: string,
    // Extra classes (e.g. a side-tint variant) always stripped before a fresh
    // show, on top of the base show class.
    private readonly resetClasses: readonly string[] = [],
  ) {}

  show(durationMs: number, extraClasses: readonly string[] = []): void {
    this.element.classList.remove(this.showClass, ...this.resetClasses);
    void this.element.offsetWidth; // force reflow so the animation restarts every call
    this.element.classList.add(this.showClass, ...extraClasses);
    if (this.timeoutId !== undefined) clearTimeout(this.timeoutId);
    this.timeoutId = setTimeout(() => {
      this.element.classList.remove(this.showClass);
    }, durationMs);
  }

  clear(): void {
    if (this.timeoutId !== undefined) clearTimeout(this.timeoutId);
    this.element.classList.remove(this.showClass, ...this.resetClasses);
  }
}
