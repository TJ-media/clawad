"use strict";

(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ClawAdPreview = api;

  if (root && root.document && root.ClawAdPreviewModel) {
    const start = () => {
      const controller = api.createPreviewController(root.document, root.ClawAdPreviewModel);
      controller.start();
      api.createApplyController(root.document, root.ClawAdPreviewModel).start();
    };
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", start);
    else start();
  }
})(typeof globalThis === "object" ? globalThis : this, () => {
  const REQUIRED_IDS = [
    "creativeText", "creativeBrand", "creativeUrl", "creativeCopy", "creativeBrandOutput",
    "creativeSeparator", "creativeStrip", "creativeMeta", "textCount", "brandCount",
    "validationMessage", "urlMessage",
    "mascotObject", "mascotChoices", "mascotMessage",
  ];

  function createPreviewController(documentRef, model) {
    const nodes = Object.fromEntries(REQUIRED_IDS.map((id) => [
      id,
      documentRef && typeof documentRef.getElementById === "function"
        ? documentRef.getElementById(id)
        : null,
    ]));
    let previewCounter = 0;
    let selectedMascot = null;
    let layoutScheduled = false;

    function syncCreativeLayout() {
      const strip = nodes.creativeStrip;
      if (!strip || !strip.style || typeof strip.getBoundingClientRect !== "function") return;

      const cutout = strip.style.getPropertyValue("--creative-cutout-width");
      const previousWidth = strip.style.width;
      strip.style.setProperty("--creative-cutout-width", "0px");
      strip.style.width = "max-content";
      const naturalWidth = strip.getBoundingClientRect().width;
      if (model && typeof model.clampCreativeWidth === "function") {
        strip.style.width = `${model.clampCreativeWidth(naturalWidth)}px`;
      } else {
        strip.style.width = previousWidth;
      }

      if (nodes.creativeMeta && typeof nodes.creativeMeta.getBoundingClientRect === "function") {
        const view = documentRef && documentRef.defaultView;
        const computed = view && typeof view.getComputedStyle === "function"
          ? view.getComputedStyle(strip)
          : null;
        const gap = computed ? parseFloat(computed.columnGap) : 0;
        const metaWidth = nodes.creativeMeta.getBoundingClientRect().width;
        if (Number.isFinite(metaWidth)) {
          strip.style.setProperty("--creative-cutout-width", `${Math.ceil(metaWidth + (Number.isFinite(gap) ? gap : 0))}px`);
          return;
        }
      }

      if (cutout) strip.style.setProperty("--creative-cutout-width", cutout);
      else strip.style.removeProperty("--creative-cutout-width");
    }

    function scheduleCreativeLayout() {
      const view = documentRef && documentRef.defaultView;
      if (!view || typeof view.requestAnimationFrame !== "function") {
        syncCreativeLayout();
        return;
      }
      if (layoutScheduled) return;
      layoutScheduled = true;
      view.requestAnimationFrame(() => {
        layoutScheduled = false;
        syncCreativeLayout();
      });
    }

    function render() {
      if (!nodes.creativeText || !nodes.creativeBrand || !model || typeof model.buildPreviewState !== "function") return null;
      const state = model.buildPreviewState({
        text: nodes.creativeText.value,
        brand: nodes.creativeBrand.value,
      });
      if (nodes.creativeCopy) nodes.creativeCopy.textContent = state.text;
      if (nodes.creativeBrandOutput) nodes.creativeBrandOutput.textContent = state.brand;
      if (nodes.creativeSeparator) nodes.creativeSeparator.textContent = state.brand ? "·" : "";
      if (nodes.textCount) nodes.textCount.textContent = `${state.textLength} / ${model.PREVIEW_TEXT_MAX_LENGTH}`;
      if (nodes.brandCount) nodes.brandCount.textContent = `${state.brandLength} / ${model.PREVIEW_BRAND_MAX_LENGTH}`;
      if (nodes.validationMessage) nodes.validationMessage.textContent = state.textEmpty ? "광고 문구를 입력해 주세요." : "";
      const link = model && typeof model.normalizePreviewLink === "function"
        ? model.normalizePreviewLink(nodes.creativeUrl ? nodes.creativeUrl.value : "")
        : { href: "", invalid: false };
      if (nodes.creativeCopy && typeof nodes.creativeCopy.setAttribute === "function") {
        if (link.href) nodes.creativeCopy.setAttribute("href", link.href);
        else if (typeof nodes.creativeCopy.removeAttribute === "function") nodes.creativeCopy.removeAttribute("href");
      }
      if (nodes.urlMessage) {
        nodes.urlMessage.textContent = link.invalid
          ? "올바른 웹 주소를 입력해 주세요. HTTPS 주소만 사용할 수 있습니다."
          : "";
      }
      syncCreativeLayout();
      return state;
    }

    function selectMascot(id) {
      const mascot = model && typeof model.findMascot === "function" ? model.findMascot(id) : null;
      if (!mascot) return null;
      selectedMascot = mascot;
      previewCounter += 1;
      if (nodes.mascotMessage) nodes.mascotMessage.textContent = "";
      if (nodes.mascotObject) {
        nodes.mascotObject.data = `assets/${mascot.file}?preview=${previewCounter}`;
        nodes.mascotObject.textContent = `${mascot.nameKo} 마스코트`;
        if (typeof nodes.mascotObject.setAttribute === "function") {
          nodes.mascotObject.setAttribute("aria-label", mascot.nameKo);
        }
      }
      if (nodes.mascotChoices && nodes.mascotChoices.children) {
        for (const button of nodes.mascotChoices.children) {
          if (button && typeof button.setAttribute === "function") {
            button.setAttribute("aria-pressed", button.dataset && button.dataset.mascotId === mascot.id ? "true" : "false");
          }
        }
      }
      return mascot;
    }

    function createMascotChoices() {
      if (!nodes.mascotChoices || !documentRef || typeof documentRef.createElement !== "function" || !model.MASCOTS) return;
      for (const mascot of model.MASCOTS) {
        const button = documentRef.createElement("button");
        button.type = "button";
        button.textContent = mascot.nameKo;
        button.dataset.mascotId = mascot.id;
        button.setAttribute("aria-pressed", "false");
        button.addEventListener("click", () => selectMascot(mascot.id));
        if (typeof nodes.mascotChoices.appendChild === "function") nodes.mascotChoices.appendChild(button);
      }
    }

    function start() {
      const view = documentRef && documentRef.defaultView;
      if (nodes.creativeText && typeof nodes.creativeText.addEventListener === "function") nodes.creativeText.addEventListener("input", render);
      if (nodes.creativeBrand && typeof nodes.creativeBrand.addEventListener === "function") nodes.creativeBrand.addEventListener("input", render);
      if (nodes.creativeUrl && typeof nodes.creativeUrl.addEventListener === "function") nodes.creativeUrl.addEventListener("input", render);
      if (view && typeof view.addEventListener === "function") view.addEventListener("resize", scheduleCreativeLayout);
      if (nodes.mascotObject && typeof nodes.mascotObject.addEventListener === "function") {
        nodes.mascotObject.addEventListener("error", () => {
          if (nodes.mascotMessage) nodes.mascotMessage.textContent = "마스코트 이미지를 불러오지 못했습니다.";
        });
        nodes.mascotObject.addEventListener("load", () => {
          if (nodes.mascotMessage) nodes.mascotMessage.textContent = "";
        });
      }
      createMascotChoices();
      render();
      if (!selectedMascot && model.DEFAULT_MASCOT_ID) selectMascot(model.DEFAULT_MASCOT_ID);
    }

    return { start, render, selectMascot };
  }

  /** 숫자만 남긴다. 원 단위 아래·음수·문자를 입력 단계에서 잘라낸다. */
  function parseAmount(raw) {
    const digits = String(raw == null ? "" : raw).replace(/[^0-9]/g, "").slice(0, 12);
    return { digits, value: digits ? Number(digits) : null };
  }

  function formatKrw(value) {
    return `${Number(value).toLocaleString("ko-KR")}원`;
  }

  /** 이메일 또는 국내 휴대전화. 서버가 같은 판정을 다시 하며 여기 결과는 안내용이다. */
  function classifyContact(raw) {
    const value = String(raw == null ? "" : raw).trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 254) return "EMAIL";
    if (/^01[016789]\d{7,8}$/.test(value.replace(/[\s-]/g, ""))) return "PHONE";
    return null;
  }

  const APPLY_IDS = [
    "applyToggle", "applyPanel", "applySubmit", "applyMessage",
    "unitPrice", "depositRangeCopy", "estimateValue",
    "depositAmount", "amountMessage", "depositorName", "depositorMessage",
    "contact", "contactMessage", "company",
    "creativeText", "creativeBrand", "creativeUrl",
    "previewStage", "confirmDialog", "confirmStage", "confirmAmount", "confirmImpressions",
    "confirmDepositor", "confirmContact", "confirmCancel", "confirmClose", "confirmSubmit",
  ];

  /**
   * 광고 신청 (CLAW-248).
   *
   * **금액·단가·예상 노출을 화면이 정하지 않는다** (rules §2·§5). 단가와 입금액 범위는 서버가
   * 내려주고, 못 받으면 숫자를 지어내지 않고 신청 자체를 막는다. 화면의 예상 노출은 안내용이며
   * 접수 결과는 서버 계산값으로 알린다.
   */
  function createApplyController(documentRef, model) {
    const nodes = Object.fromEntries(APPLY_IDS.map((id) => [
      id,
      documentRef && typeof documentRef.getElementById === "function" ? documentRef.getElementById(id) : null,
    ]));
    let limits = null;
    let submitting = false;

    const fetchImpl = () => {
      const view = documentRef && documentRef.defaultView;
      return view && typeof view.fetch === "function" ? view.fetch.bind(view) : null;
    };

    const valueOf = (node) => (node && typeof node.value === "string" ? node.value : "");

    function setMessage(node, text) {
      if (node) node.textContent = text || "";
    }

    function renderEstimate() {
      if (!nodes.estimateValue) return;
      const { value } = parseAmount(valueOf(nodes.depositAmount));
      if (!limits || !value) {
        nodes.estimateValue.textContent = "—";
        return;
      }
      nodes.estimateValue.textContent = `${Math.floor(value / limits.pricePerImpressionKrw).toLocaleString("ko-KR")}회`;
    }

    async function loadLimits() {
      const doFetch = fetchImpl();
      if (!doFetch) return null;
      try {
        const response = await doFetch("/v1/inquiries/limits", { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        if (!Number.isFinite(body.pricePerImpressionKrw) || body.pricePerImpressionKrw <= 0) {
          throw new Error("단가 없음");
        }
        limits = body;
        if (nodes.unitPrice) nodes.unitPrice.textContent = formatKrw(body.pricePerImpressionKrw);
        if (nodes.depositRangeCopy) {
          nodes.depositRangeCopy.textContent =
            `${formatKrw(body.minDepositKrw)}부터 ${formatKrw(body.maxDepositKrw)}까지 신청할 수 있습니다.`;
        }
        if (nodes.applySubmit) nodes.applySubmit.disabled = false;
        setMessage(nodes.applyMessage, "");
        renderEstimate();
        return limits;
      } catch {
        limits = null;
        if (nodes.unitPrice) nodes.unitPrice.textContent = "—";
        if (nodes.depositRangeCopy) nodes.depositRangeCopy.textContent = "입금 가능 금액을 불러오지 못했습니다.";
        if (nodes.applySubmit) nodes.applySubmit.disabled = true;
        setMessage(nodes.applyMessage, "단가 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
        return null;
      }
    }

    function onAmountInput() {
      if (!nodes.depositAmount) return;
      const { digits, value } = parseAmount(nodes.depositAmount.value);
      nodes.depositAmount.value = value ? value.toLocaleString("ko-KR") : digits;
      setMessage(nodes.amountMessage, "");
      renderEstimate();
    }

    /** 첫 번째 문제만 알린다. 한 번에 여러 줄을 띄우면 무엇부터 고칠지 알기 어렵다. */
    function validate() {
      const fail = (node, text) => ({ ok: false, node, text });
      if (!limits) return fail(nodes.applyMessage, "단가 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");

      const state = model.buildPreviewState({
        text: valueOf(nodes.creativeText),
        brand: valueOf(nodes.creativeBrand),
      });
      if (state.textEmpty) return fail(nodes.applyMessage, "광고 문구를 입력해 주세요.");
      if (!state.brand) return fail(nodes.applyMessage, "광고주명을 입력해 주세요.");

      const link = model.normalizePreviewLink(valueOf(nodes.creativeUrl));
      if (link.invalid) return fail(nodes.applyMessage, "연결 링크를 확인해 주세요. HTTPS 주소만 사용할 수 있습니다.");

      const { value: amount } = parseAmount(valueOf(nodes.depositAmount));
      if (!amount) return fail(nodes.amountMessage, "입금할 금액을 입력해 주세요.");
      if (amount < limits.minDepositKrw) return fail(nodes.amountMessage, `최소 ${formatKrw(limits.minDepositKrw)}부터 신청할 수 있습니다.`);
      if (amount > limits.maxDepositKrw) return fail(nodes.amountMessage, `최대 ${formatKrw(limits.maxDepositKrw)}까지 신청할 수 있습니다.`);

      const depositorName = valueOf(nodes.depositorName).trim();
      if (!depositorName) return fail(nodes.depositorMessage, "예금주 이름을 입력해 주세요.");

      const contact = valueOf(nodes.contact).trim();
      if (!classifyContact(contact)) return fail(nodes.contactMessage, "전화번호 또는 이메일 형식으로 입력해 주세요.");

      const payload = {
        creativeText: state.text,
        brandName: state.brand,
        depositAmountKrw: amount,
        depositorName,
        contact,
      };
      if (link.href) payload.linkUrl = link.href;
      const trap = valueOf(nodes.company);
      if (trap) payload.company = trap;
      return { ok: true, payload };
    }

    function clearMessages() {
      for (const node of [nodes.applyMessage, nodes.amountMessage, nodes.depositorMessage, nodes.contactMessage]) {
        setMessage(node, "");
      }
      if (nodes.applyMessage && nodes.applyMessage.classList) nodes.applyMessage.classList.remove("is-success");
    }

    function toggle() {
      const panel = nodes.applyPanel;
      if (!panel || !panel.classList) return false;
      const open = !panel.classList.contains("is-open");
      panel.classList.toggle("is-open", open);
      if (open) panel.removeAttribute("inert");
      else panel.setAttribute("inert", "");
      if (nodes.applyToggle) {
        nodes.applyToggle.setAttribute("aria-expanded", open ? "true" : "false");
        nodes.applyToggle.textContent = open ? "신청 접기" : "광고 신청하기";
      }
      if (open && typeof panel.scrollIntoView === "function") {
        panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      return open;
    }

    /**
     * 확인 모달의 광고판은 미리보기 무대를 **복제**해 넣는다. 마크업을 한 벌 더 두면 광고판 규칙이
     * 두 곳으로 갈라지고 `[광고]` 표기가 한쪽에서만 빠지는 사고가 난다.
     */
    function buildConfirmStage() {
      if (!nodes.confirmStage || !nodes.previewStage || typeof nodes.previewStage.cloneNode !== "function") return;
      const clone = nodes.previewStage.cloneNode(true);
      clone.removeAttribute("id");
      if (typeof clone.querySelectorAll === "function") {
        for (const el of clone.querySelectorAll("[id]")) el.removeAttribute("id");
      }
      nodes.confirmStage.textContent = "";
      nodes.confirmStage.appendChild(clone);
    }

    function openConfirm(payload) {
      buildConfirmStage();
      if (nodes.confirmAmount) nodes.confirmAmount.textContent = formatKrw(payload.depositAmountKrw);
      if (nodes.confirmImpressions) {
        const count = Math.floor(payload.depositAmountKrw / limits.pricePerImpressionKrw);
        nodes.confirmImpressions.textContent = `약 ${count.toLocaleString("ko-KR")}회 (예상)`;
      }
      if (nodes.confirmDepositor) nodes.confirmDepositor.textContent = payload.depositorName;
      if (nodes.confirmContact) nodes.confirmContact.textContent = payload.contact;
      if (nodes.confirmDialog && typeof nodes.confirmDialog.showModal === "function") nodes.confirmDialog.showModal();
    }

    function closeConfirm() {
      if (nodes.confirmDialog && typeof nodes.confirmDialog.close === "function") nodes.confirmDialog.close();
    }

    async function submit(payload) {
      const doFetch = fetchImpl();
      if (!doFetch || submitting) return false;
      submitting = true;
      if (nodes.confirmSubmit) nodes.confirmSubmit.disabled = true;
      try {
        const response = await doFetch("/v1/inquiries", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(payload),
        });
        if (response.status === 429) throw new Error("요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
        if (!response.ok) throw new Error("신청을 접수하지 못했습니다. 입력 내용을 확인해 주세요.");
        const body = await response.json();
        closeConfirm();
        // 노출 횟수는 **서버 계산값**으로 알린다 — 화면 추정치를 결과로 쓰지 않는다.
        const count = Number(body.estimatedImpressions).toLocaleString("ko-KR");
        setMessage(nodes.applyMessage, `신청이 접수되었습니다. 예상 인정 노출 ${count}회. 안내해 드린 계좌로 입금해 주세요.`);
        if (nodes.applyMessage && nodes.applyMessage.classList) nodes.applyMessage.classList.add("is-success");
        return true;
      } catch (error) {
        closeConfirm();
        if (nodes.applyMessage && nodes.applyMessage.classList) nodes.applyMessage.classList.remove("is-success");
        setMessage(nodes.applyMessage, error instanceof Error ? error.message : "신청을 접수하지 못했습니다.");
        return false;
      } finally {
        submitting = false;
        if (nodes.confirmSubmit) nodes.confirmSubmit.disabled = false;
      }
    }

    function onConfirmClick() {
      clearMessages();
      const result = validate();
      if (!result.ok) {
        setMessage(result.node, result.text);
        return;
      }
      openConfirm(result.payload);
      if (nodes.confirmSubmit) nodes.confirmSubmit.onclick = () => submit(result.payload);
    }

    function start() {
      const on = (node, event, handler) => {
        if (node && typeof node.addEventListener === "function") node.addEventListener(event, handler);
      };
      on(nodes.applyToggle, "click", toggle);
      on(nodes.depositAmount, "input", onAmountInput);
      on(nodes.applySubmit, "click", onConfirmClick);
      on(nodes.confirmCancel, "click", closeConfirm);
      on(nodes.confirmClose, "click", closeConfirm);
      // 배경 클릭으로 닫는다. Esc 닫기·포커스 트랩·배경 딤은 <dialog>가 이미 해준다.
      on(nodes.confirmDialog, "click", (event) => {
        if (event.target === nodes.confirmDialog) closeConfirm();
      });
      if (nodes.applySubmit) nodes.applySubmit.disabled = true;
      loadLimits();
    }

    return { start, toggle, validate, submit, loadLimits, renderEstimate };
  }

  return { createPreviewController, createApplyController, REQUIRED_IDS, APPLY_IDS, parseAmount, classifyContact };
});
