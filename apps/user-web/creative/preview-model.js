"use strict";

(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ClawAdPreviewModel = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const DEFAULT_MASCOT_ID = "building";
  const PREVIEW_TEXT_MAX_LENGTH = 48;
  const PREVIEW_BRAND_MAX_LENGTH = 23;
  const MIN_CREATIVE_WIDTH = 240;
  const MAX_CREATIVE_WIDTH = 420;
  const MASCOTS = Object.freeze([
    { id: "idle", nameKo: "대기", categoryKo: "기본", file: "clawad-idle.svg", compact: false },
    { id: "mini-enter", nameKo: "입장", categoryKo: "미니", file: "clawad-mini-enter.svg", compact: true },
    { id: "thinking", nameKo: "생각 중", categoryKo: "기본", file: "clawad-thinking.svg", compact: false },
    { id: "attention", nameKo: "작업 끝", categoryKo: "기본", file: "clawad-attention.svg", compact: false },
    { id: "notification", nameKo: "비상", categoryKo: "기본", file: "clawad-notification.svg", compact: false },
    { id: "error", nameKo: "오류", categoryKo: "기본", file: "clawad-error.svg", compact: false },
    { id: "working", nameKo: "작업 중", categoryKo: "작업", file: "clawad-working.svg", compact: false },
    { id: "juggling", nameKo: "2개 작업 중", categoryKo: "작업", file: "clawad-juggling.svg", compact: false },
    { id: "building", nameKo: "3개 작업 중", categoryKo: "작업", file: "clawad-building.svg", compact: false },
    { id: "conducting", nameKo: "서브에이전트 지휘", categoryKo: "작업", file: "clawad-conducting.svg", compact: false },
    { id: "yawning", nameKo: "하품", categoryKo: "휴식", file: "clawad-yawning.svg", compact: false },
    { id: "dozing", nameKo: "꾸벅꾸벅", categoryKo: "휴식", file: "clawad-dozing.svg", compact: false },
    { id: "collapsing", nameKo: "잠들기", categoryKo: "휴식", file: "clawad-collapsing.svg", compact: false },
    { id: "sleeping", nameKo: "수면", categoryKo: "휴식", file: "clawad-sleeping.svg", compact: false },
    { id: "waking", nameKo: "기상", categoryKo: "휴식", file: "clawad-waking.svg", compact: false },
    { id: "drag", nameKo: "매달리기", categoryKo: "반응", file: "clawad-react-drag.svg", compact: false },
    { id: "poke", nameKo: "웃음", categoryKo: "반응", file: "clawad-react-poke.svg", compact: false },
    { id: "double", nameKo: "하트", categoryKo: "반응", file: "clawad-react-double.svg", compact: false },
    { id: "dizzy", nameKo: "헤롱헤롱", categoryKo: "반응", file: "clawad-dizzy.svg", compact: false },
    // 앱에는 전신으로 걷는 roam이 따로 있지만(CLAW-286) 이 목록에 함께 두면 게걸음과 너무
    // 비슷해 둘 다 고르기 어려워진다. 이동은 게걸음 하나로 둔다.
    { id: "mini-crabwalk", nameKo: "이동", categoryKo: "미니", file: "clawad-mini-crabwalk.svg", compact: true },
  ].map((mascot) => Object.freeze(mascot)));

  function sanitizeField(value, maxLength) {
    const text = typeof value === "string" ? value : "";
    const normalized = text
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return [...normalized].slice(0, maxLength).join("");
  }

  function buildPreviewState(input = {}) {
    const text = sanitizeField(input.text, PREVIEW_TEXT_MAX_LENGTH);
    const brand = sanitizeField(input.brand, PREVIEW_BRAND_MAX_LENGTH);
    return {
      text,
      brand,
      textLength: [...text].length,
      brandLength: [...brand].length,
      textEmpty: text.length === 0,
    };
  }

  function normalizePreviewLink(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return { href: "", invalid: false };
    if (/\s/.test(raw)) return { href: "", invalid: true };

    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
    if (hasScheme && !/^https:\/\//i.test(raw)) return { href: "", invalid: true };

    try {
      const parsed = new URL(hasScheme ? raw : `https://${raw}`);
      const labels = parsed.hostname.split(".");
      const validHostname = labels.length >= 2 && labels.every((label) => (
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)
      ));
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || !validHostname) {
        return { href: "", invalid: true };
      }
      return { href: parsed.href, invalid: false };
    } catch {
      return { href: "", invalid: true };
    }
  }

  function findMascot(id) {
    return MASCOTS.find((mascot) => mascot.id === id)
      || MASCOTS.find((mascot) => mascot.id === DEFAULT_MASCOT_ID);
  }

  function clampCreativeWidth(naturalWidth) {
    if (!Number.isFinite(naturalWidth) || naturalWidth <= 0) return MAX_CREATIVE_WIDTH;
    return Math.min(MAX_CREATIVE_WIDTH, Math.max(MIN_CREATIVE_WIDTH, Math.ceil(naturalWidth)));
  }

  return {
    sanitizeField,
    buildPreviewState,
    normalizePreviewLink,
    PREVIEW_TEXT_MAX_LENGTH,
    PREVIEW_BRAND_MAX_LENGTH,
    clampCreativeWidth,
    DEFAULT_MASCOT_ID,
    MASCOTS,
    findMascot,
  };
});
