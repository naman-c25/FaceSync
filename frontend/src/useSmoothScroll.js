import { useEffect } from 'react';
import Lenis from 'lenis';

/**
 * Momentum scrolling for one element, plus the scroll position every animation
 * on the page reads from.
 *
 * Two things are worth knowing about this.
 *
 * **It replaces CSS scroll snapping rather than joining it.** Lenis animates
 * the real scroll position frame by frame; snapping tries to seize that same
 * position the moment a gesture ends. Run both and every flick ends in a tug
 * of war that reads as stutter, so the stylesheet no longer snaps.
 *
 * **It must be allowed to fail.** A page whose scroll has been taken over by
 * a library that then throws is a page nobody can read. Everything here is
 * wrapped, and the fallback is not a degraded mode — it is the browser's own
 * scrolling, which was never broken. Anyone who has asked their system for
 * less motion is given that directly, without loading the library at all.
 *
 * Rather than firing React state on every frame, scroll progress is written
 * to CSS custom properties. Re-rendering a tree sixty times a second to move
 * something a few pixels is how a smooth page becomes a janky one; the
 * compositor can read a variable without React hearing about it.
 *
 * @param {object} ref  the scrolling element, whose first child holds the content
 */
export function useSmoothScroll(ref) {
  useEffect(() => {
    const wrapper = ref.current;
    const content = wrapper?.firstElementChild;
    if (!wrapper || !content) return undefined;

    const reduced = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    /** Write how far each panel has travelled through the viewport. */
    const measure = () => {
      const height = wrapper.clientHeight || 1;
      const span = Math.max(1, wrapper.scrollHeight - height);
      wrapper.style.setProperty(
        '--scroll',
        String(Math.min(1, Math.max(0, wrapper.scrollTop / span))),
      );

      for (const panel of wrapper.querySelectorAll('.panel')) {
        const box = panel.getBoundingClientRect();
        // 0 when the panel's top edge is at the bottom of the screen, 1 once
        // its bottom edge has passed the top. Half is dead centre, which is
        // what the stylesheet anchors its effects to.
        const progress = (height - box.top) / (height + box.height);
        panel.style.setProperty(
          '--p',
          String(Math.min(1, Math.max(0, progress))),
        );
      }
    };

    measure();

    if (reduced) {
      wrapper.addEventListener('scroll', measure, { passive: true });
      return () => wrapper.removeEventListener('scroll', measure);
    }

    let lenis;
    let frame;

    try {
      lenis = new Lenis({
        wrapper,
        content,
        // Long enough to feel like weight, short enough that a reader trying
        // to get somewhere does not have to wait for the page to agree.
        duration: 1.15,
        easing: (t) => 1 - Math.pow(1 - t, 3),
        smoothWheel: true,
        // Touch devices already have momentum of their own, and layering a
        // second one on top makes a flick feel slippery and unaccountable.
        syncTouch: false,
      });

      lenis.on('scroll', measure);

      const loop = (time) => {
        lenis.raf(time);
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
    } catch (cause) {
      console.warn('[scroll] falling back to native scrolling:', cause.message);
      wrapper.addEventListener('scroll', measure, { passive: true });
      return () => wrapper.removeEventListener('scroll', measure);
    }

    window.addEventListener('resize', measure);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
      lenis.destroy();
    };
  }, [ref]);
}
