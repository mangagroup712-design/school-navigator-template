import type { PamphletPage } from "../types/types";

import { requireMap } from "./map/state";
import { timeout } from "./util";

const PAMPHLET_PAGES: PamphletPage[] = ["map", "help"];
const SLIDE_ANIMATION = {
  /**ページを端から端までスクロールするときの秒数 */
  pageSlideSeconds: 0.3,
  /**開始ページのイージング */
  startEase: "ease",
  /**中間ページのイージング */
  middleEase: "ease",
  /**終了ページのイージング */
  endEase: "ease",
};

for (const pamphletPage of PAMPHLET_PAGES) {
  document
    .getElementById(`nav-${pamphletPage}-btn`)
    ?.addEventListener("click", () => {
      pageState.page = pamphletPage;
    });
}

const menuToggle = document.getElementById("menu-toggle");
const siteNav = document.getElementById("site-nav");
menuToggle?.addEventListener("click", () => {
  const isOpen = siteNav?.classList.toggle("menu-open") ?? false;
  menuToggle.setAttribute("aria-expanded", String(isOpen));
});

async function slidePage(from: PamphletPage, to: PamphletPage): Promise<void> {
  if (from === to) return;
  const fromIndex = PAMPHLET_PAGES.indexOf(from);
  const toIndex = PAMPHLET_PAGES.indexOf(to);
  if (toIndex === -1)
    throw new Error(`slidePage: Slide to a non-existent page: ${to}`);
  if (fromIndex === -1) {
    // 元が存在しなければスライドできない
    const toElement = document.getElementById(`${to}-page`);
    if (!toElement) throw new Error(`slidePage: not found element #${to}-page`);
    toElement.style.display = "block";
  }
  const slideMin = Math.min(fromIndex, toIndex);
  const slideMax = Math.max(fromIndex, toIndex);
  const isSlideToLeft = fromIndex > toIndex;
  const slideTargets = PAMPHLET_PAGES.slice(slideMin, slideMax + 1)
    .map((p) => document.getElementById(`${p}-page`))
    .filter((p): p is HTMLElement => !!p);
  if (isSlideToLeft) slideTargets.reverse();
  let slideIndex = 0;
  const slideStartStyle: Keyframe = {
    transform: `translateX(${isSlideToLeft ? "-" : ""}100vw)`,
  };
  const slideMiddleStyle: Keyframe = {
    transform: `none`,
  };
  const slideEndStyle: Keyframe = {
    transform: `translateX(${isSlideToLeft ? "" : "-"}100vw)`,
  };
  for (const slideTarget of slideTargets) {
    const keyframes: Keyframe[] = [];
    let duration = 0;
    let ease = SLIDE_ANIMATION.middleEase;
    if (slideIndex > 1) {
      await timeout(SLIDE_ANIMATION.pageSlideSeconds * 500);
    }
    if (slideIndex === 0) {
      keyframes.push(slideMiddleStyle);
      ease = SLIDE_ANIMATION.startEase;
    } else {
      duration += SLIDE_ANIMATION.pageSlideSeconds * 500;
      setTimeout(() => {
        slideTarget.style.display = "unset";
      }, 20);
      keyframes.push(slideStartStyle);
    }
    if (slideIndex === slideTargets.length - 1) {
      ease = SLIDE_ANIMATION.endEase;

      keyframes.push(slideMiddleStyle);
    } else {
      duration += SLIDE_ANIMATION.pageSlideSeconds * 500;
      setTimeout(() => {
        slideTarget.style.display = "none";
      }, duration - 20);
      keyframes.push(slideEndStyle);
    }

    slideTarget.animate(keyframes, { easing: ease, duration });
    setTimeout(() => {
      requireMap().invalidateSize();
    }, duration + 50);
    slideIndex++;
  }
}

const pageState = {
  _page: "map" as PamphletPage,
  get page(): PamphletPage {
    return this._page;
  },
  set page(value: PamphletPage) {
    for (const pamphletPage of PAMPHLET_PAGES) {
      const btnElement = document.getElementById(`nav-${pamphletPage}-btn`);
      if (!btnElement) continue;
      btnElement.classList.remove("active-page");
      if (pamphletPage === value) btnElement.classList.add("active-page");
    }
    slidePage(this._page, value);
    this._page = value;
    siteNav?.classList.remove("menu-open");
    menuToggle?.setAttribute("aria-expanded", "false");
  },
};

export { pageState, PAMPHLET_PAGES };
