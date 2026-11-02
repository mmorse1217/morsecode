(() => {
  const bar = document.querySelector('.topbar');
  const slot = document.querySelector('.nav-slot');
  const nav = slot.querySelector('.hero-nav');
  let docked = false;
  let scheduled = false;

  function update() {
    scheduled = false;
    const barCenter = bar.getBoundingClientRect().height / 2;
    const slotRect = slot.getBoundingClientRect();
    const shouldDock = slotRect.top + slotRect.height / 2 <= barCenter;
    if (shouldDock === docked) return;
    docked = shouldDock;
    bar.classList.toggle('nav-docked', docked);
    (docked ? bar : slot).appendChild(nav);
  }

  function scheduleUpdate() {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(update);
    }
  }

  window.addEventListener('scroll', scheduleUpdate, { passive: true });
  window.addEventListener('resize', scheduleUpdate);
  update();
})();
