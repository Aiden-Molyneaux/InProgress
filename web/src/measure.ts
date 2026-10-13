/**
 * Measurements of how the window is used (spec 2.6). The Board calls noteAction for a click in a band; the gap logic
 * that turns the first click after an hour away into `window.first_action` comes with the measuring task, so for now
 * this does nothing.
 */
export function noteAction(area: string, action: string): void {
  void area;
  void action;
}
