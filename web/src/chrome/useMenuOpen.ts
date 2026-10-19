import { useEffect, useState } from 'react';

const MENU = '.ip-menu, .p-menu, [role="menu"]';

/** Whether any menu is open anywhere in the page: it watches the document for one coming and going, and sets state only when the answer changes. */
export function useMenuOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const root = document.getElementById('root') ?? document.body;
    const check = () => setOpen(root.querySelector(MENU) !== null);
    check();
    const watch = new MutationObserver(check);
    watch.observe(root, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, []);
  return open;
}
