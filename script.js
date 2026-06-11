(() => {
  "use strict";

  const GB_PER_TB = 1000;
  const TB_PER_PB = 1000;
  const MILLION = 1_000_000;
  const THEME_STORAGE_KEY = "b2-payg-theme-v2";
  const THEME_MODES = ["light", "dark", "system"];
  const STYLE_STORAGE_KEY = "b2-payg-style";
  const STYLES = ["premium", "dramatic", "bright"];
  const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

  /* =====================================================================
     PRICING ENGINE (data + math): unchanged from the approved model.
     ===================================================================== */
  const WORKLOADS = {
    active: {
      label: "Active archive",
      storageTB: 250,
      egressPct: 12,
      classA: 1.5,
      classB: 8,
      classC: 0.2,
      deletion: "rare",
      region: "us",
      tierProfile: "auto",
      growthPct: 10,
    },
    backup: {
      label: "Backup and DR",
      storageTB: 100,
      egressPct: 25,
      classA: 2,
      classB: 5,
      classC: 0.5,
      deletion: "retention",
      region: "us",
      tierProfile: "auto",
      growthPct: 20,
    },
    app: {
      label: "Application storage",
      storageTB: 40,
      egressPct: 150,
      classA: 30,
      classB: 180,
      classC: 12,
      deletion: "weekly",
      region: "us",
      tierProfile: "auto",
      growthPct: 35,
    },
    custom: {
      label: "Custom",
      storageTB: 50,
      egressPct: 60,
      classA: 5,
      classB: 25,
      classC: 1,
      deletion: "monthly",
      region: "us",
      tierProfile: "auto",
      growthPct: 15,
    },
  };

  const DELETION = {
    rare: {
      label: "Rarely",
      churn: 0.02,
      avgDaysHeld: 365,
      summary: "2% monthly churn, held longer than minimum floors",
    },
    retention: {
      label: "Retention-based",
      churn: 0.08,
      avgDaysHeld: 45,
      summary: "8% monthly churn, average 45-day object lifetime",
    },
    monthly: {
      label: "Monthly",
      churn: 0.18,
      avgDaysHeld: 30,
      summary: "18% monthly churn, average 30-day object lifetime",
    },
    weekly: {
      label: "Weekly",
      churn: 0.45,
      avgDaysHeld: 7,
      summary: "45% monthly churn, average 7-day object lifetime",
    },
    daily: {
      label: "Daily",
      churn: 0.85,
      avgDaysHeld: 1,
      summary: "85% monthly churn, average 1-day object lifetime",
    },
  };

  const REGION = {
    us: { label: "United States", egressMultiplier: 1 },
    eu: { label: "Europe", egressMultiplier: 1.04 },
    apac: { label: "Asia Pacific", egressMultiplier: 1.28 },
  };

  const PROVIDERS = [
    {
      id: "b2",
      name: "Backblaze B2",
      vendor: "PAYG, always-hot",
      suffix: "",
      logo: "assets/logos/b2-short-red-navy.svg",
      accent: "#e20626",
      accentStrong: "#b40a23",
      accentRgb: "226, 6, 38",
      isB2: true,
      storageRate: 6.95 / GB_PER_TB,
      storageLabel: "$6.95 / TB-month",
      egressRate: 0.01,
      egressLabel: "3x stored data free, then $0.01 / GB",
      freeEgress: (storageGB) => storageGB * 3,
      operationsLabel: "Class A/B/C transactions free",
      minDays: 0,
    },
    {
      id: "aws",
      name: "Amazon S3",
      vendor: "AWS",
      suffix: "S3",
      logo: "assets/logos/aws-s3.svg",
      accent: "#ff9900",
      accentStrong: "#ec7211",
      accentRgb: "255, 153, 0",
      egressRate: 0.09,
      egressLabel: "First 100 GB free, then modeled at $0.09 / GB",
      freeEgress: () => 100,
      regionAware: true,
      operationsLabel: "Class A and B request pricing",
      opRates: { classA1000: 0.005, classB1000: 0.0004, classC1000: 0 },
      tiers: {
        standard: { label: "Standard", rate: 0.023, minDays: 0 },
        ia: { label: "Standard-IA", rate: 0.0125, minDays: 30 },
        glacier: { label: "Glacier Instant", rate: 0.004, minDays: 90 },
      },
    },
    {
      id: "azure",
      name: "Azure Blob Storage",
      vendor: "Microsoft Azure",
      suffix: "Blob",
      logo: "assets/logos/microsoft-azure.webp",
      accent: "#0078d4",
      accentStrong: "#50b9ff",
      accentRgb: "0, 120, 212",
      egressRate: 0.0875,
      egressLabel: "First 100 GB free, then modeled at $0.0875 / GB",
      freeEgress: () => 100,
      regionAware: true,
      operationsLabel: "Read/write operation pricing",
      opRates: { classA1000: 0.0065, classB1000: 0.0005, classC1000: 0 },
      tiers: {
        hot: { label: "Hot", rate: 0.0184, minDays: 0 },
        cool: { label: "Cool", rate: 0.01, minDays: 30 },
        archive: { label: "Archive", rate: 0.00099, minDays: 180 },
      },
    },
    {
      id: "r2",
      name: "Cloudflare R2",
      vendor: "Object Storage",
      suffix: "R2",
      logo: "assets/logos/cloudflare.svg",
      accent: "#f6821f",
      accentStrong: "#faae40",
      accentRgb: "246, 130, 31",
      storageRate: 0.015,
      storageLabel: "$0.015 / GB-month after 10 GB free",
      storageFreeGB: 10,
      egressRate: 0,
      egressLabel: "No egress fees",
      freeEgress: () => Infinity,
      operationsLabel: "Class A/B operations with free tiers",
      r2Ops: true,
      minDays: 0,
    },
    {
      id: "gcs",
      name: "Google Cloud Storage",
      vendor: "Google Cloud",
      suffix: "",
      logo: "assets/logos/google-cloud.svg",
      accent: "#34a853",
      accentStrong: "#4285f4",
      accentRgb: "52, 168, 83",
      egressRate: 0.12,
      egressLabel: "First 100 GB free, then modeled at $0.12 / GB",
      freeEgress: () => 100,
      regionAware: true,
      operationsLabel: "Class A and B request pricing",
      opRates: { classA1000: 0.005, classB1000: 0.0004, classC1000: 0 },
      tiers: {
        standard: { label: "Standard", rate: 0.02, minDays: 0 },
        nearline: { label: "Nearline", rate: 0.01, minDays: 30 },
        coldline: { label: "Coldline", rate: 0.004, minDays: 90 },
      },
    },
  ];

  const AUTO_TIERS = {
    active: { aws: "glacier", gcs: "coldline", azure: "cool" },
    backup: { aws: "ia", gcs: "nearline", azure: "cool" },
    app: { aws: "standard", gcs: "standard", azure: "hot" },
    custom: { aws: "standard", gcs: "standard", azure: "hot" },
  };

  const STANDARD_TIERS = { aws: "standard", gcs: "standard", azure: "hot" };
  const COLD_TIERS = { aws: "glacier", gcs: "coldline", azure: "archive" };

  const state = {
    workload: "active",
    storageTB: WORKLOADS.active.storageTB,
    storageUnit: "TB",
    egressPct: WORKLOADS.active.egressPct,
    period: "monthly",
    compare: "aws",
    themeMode: readThemeMode(),
    style: readStyle(),
    advancedUnlocked: false,
    advancedDraft: draftFromWorkload("active"),
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const els = {
    billingButtons: $$("[data-billing]"),
    themeButtons: $$("[data-theme-choice]"),
    themeMenu: $("[data-theme-menu]"),
    themeTrigger: $("[data-theme-trigger]"),
    themePopover: $("[data-theme-popover]"),
    styleSelect: $("[data-style-select]"),
    presetButtons: $$(".preset-card"),
    storageValue: $("#storage-value"),
    storageUnit: $("#storage-unit"),
    storageRange: $("#storage-range"),
    egressValue: $("#egress-percent"),
    egressRange: $("#egress-range"),
    egressProgress: $("[data-egress-progress]"),
    egressNote: $("[data-egress-note]"),
    classA: $("#class-a"),
    classB: $("#class-b"),
    classC: $("#class-c"),
    deletion: $("#deletion-frequency"),
    region: $("#region"),
    tierProfile: $("#tier-profile"),
    annualGrowth: $("#annual-growth"),
    advancedStatus: $("[data-advanced-status]"),
    applyAdvanced: $("[data-apply-advanced]"),
    printReport: $("[data-print-report]"),
    compareProvider: $("#compare-provider"),
    periodLabel: $("[data-period-label]"),
    b2TotalLarge: $("[data-b2-total-large]"),
    savings: $("[data-savings]"),
    savingsCopy: $("[data-savings-copy]"),
    savingsPercent: $("[data-savings-percent]"),
    freeEgress: $("[data-free-egress]"),
    liveSummary: $("[data-live-summary]"),
    b2Lines: $("[data-b2-lines]"),
    compareChart: $("[data-compare-chart]"),
    providerCards: $("[data-provider-cards]"),
    advancedOutput: $("[data-advanced-output]"),
    projectionCards: $("[data-projection-cards]"),
    assumptions: $("[data-assumption-rows]"),
    shareScenario: $("[data-share-scenario]"),
    gateModal: $("[data-gate-modal]"),
    gateForm: $("[data-gate-form]"),
    closeGate: $("[data-close-gate]"),
    toast: $("[data-toast]"),
  };

  /* ---------- Theme + style ---------- */
  function readThemeMode() {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      return THEME_MODES.includes(stored) ? stored : "system";
    } catch {
      return "system";
    }
  }

  function setThemeMode(mode, { persist = true } = {}) {
    state.themeMode = THEME_MODES.includes(mode) ? mode : "system";
    const resolvedTheme =
      state.themeMode === "system"
        ? systemThemeQuery.matches
          ? "dark"
          : "light"
        : state.themeMode;

    document.documentElement.dataset.themeMode = state.themeMode;
    document.documentElement.dataset.theme = resolvedTheme;

    if (persist) {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, state.themeMode);
      } catch {
        // Ignore storage failures; the selected theme still applies for this session.
      }
    }

    syncThemeButtons();
  }

  function syncThemeButtons() {
    els.themeButtons.forEach((button) => {
      const active = button.dataset.themeChoice === state.themeMode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
  }

  function setThemeMenu(open) {
    if (!els.themePopover || !els.themeTrigger) return;
    els.themePopover.hidden = !open;
    els.themeTrigger.setAttribute("aria-expanded", open ? "true" : "false");
  }
  function closeThemeMenu() {
    setThemeMenu(false);
  }

  function readStyle() {
    try {
      const stored = localStorage.getItem(STYLE_STORAGE_KEY);
      return STYLES.includes(stored) ? stored : "premium";
    } catch {
      return "premium";
    }
  }

  function setStyle(style, { persist = true } = {}) {
    state.style = STYLES.includes(style) ? style : "premium";
    document.documentElement.dataset.style = state.style;
    if (els.styleSelect) els.styleSelect.value = state.style;
    if (persist) {
      try {
        localStorage.setItem(STYLE_STORAGE_KEY, state.style);
      } catch {
        // Ignore storage failures.
      }
    }
  }

  function draftFromWorkload(workload) {
    const source = WORKLOADS[workload];
    return {
      classA: source.classA,
      classB: source.classB,
      classC: source.classC,
      deletion: source.deletion,
      region: source.region,
      tierProfile: source.tierProfile,
      growthPct: source.growthPct,
    };
  }

  function readHash() {
    if (!window.location.hash || window.location.hash.length < 2) return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const workload = params.get("workload");
    if (WORKLOADS[workload]) state.workload = workload;

    const preset = WORKLOADS[state.workload];
    state.storageTB = numberOr(params.get("storageTB"), preset.storageTB);
    state.egressPct = numberOr(params.get("egressPct"), preset.egressPct);
    state.period = params.get("period") === "annual" ? "annual" : "monthly";
    state.compare = providerById(params.get("compare"))?.id || "aws";
    state.storageUnit = params.get("unit") === "PB" ? "PB" : "TB";
    state.advancedDraft = draftFromWorkload(state.workload);
  }

  function numberOr(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  function providerById(id) {
    return PROVIDERS.find((provider) => provider.id === id);
  }

  function effectiveInputs() {
    const defaults = WORKLOADS[state.workload];
    const advanced = state.advancedUnlocked ? state.advancedDraft : defaults;
    const actualTB = state.storageUnit === "PB" ? state.storageTB * TB_PER_PB : state.storageTB;
    const storageGB = actualTB * GB_PER_TB;
    const egressGB = storageGB * (state.egressPct / 100);

    return {
      workload: state.workload,
      workloadLabel: defaults.label,
      storageTB: actualTB,
      storageGB,
      egressPct: state.egressPct,
      egressGB,
      classA: advanced.classA * MILLION,
      classB: advanced.classB * MILLION,
      classC: advanced.classC * MILLION,
      deletion: DELETION[advanced.deletion] || DELETION.monthly,
      deletionKey: advanced.deletion,
      region: REGION[advanced.region] || REGION.us,
      regionKey: advanced.region,
      tierProfile: advanced.tierProfile || "auto",
      growthPct: Math.max(0, Number(advanced.growthPct) || 0),
    };
  }

  function tierFor(provider, inputs) {
    if (!provider.tiers) {
      return {
        label: provider.storageLabel || "Flat",
        rate: provider.storageRate,
        minDays: provider.minDays || 0,
      };
    }

    let tierId;
    if (inputs.tierProfile === "standard") {
      tierId = STANDARD_TIERS[provider.id];
    } else if (inputs.tierProfile === "cold") {
      tierId = COLD_TIERS[provider.id];
    } else {
      tierId = AUTO_TIERS[inputs.workload][provider.id];
    }

    return provider.tiers[tierId] || provider.tiers.standard || provider.tiers.hot;
  }

  function costFor(provider, inputs) {
    const tier = tierFor(provider, inputs);
    const storageFreeGB = provider.storageFreeGB || 0;
    const billableStorageGB = Math.max(0, inputs.storageGB - storageFreeGB);
    const storageCost = billableStorageGB * tier.rate;

    const freeEgressGB = provider.freeEgress ? provider.freeEgress(inputs.storageGB) : 0;
    const billableEgressGB = Math.max(0, inputs.egressGB - freeEgressGB);
    const regionMultiplier = provider.regionAware ? inputs.region.egressMultiplier : 1;
    const egressCost = billableEgressGB * provider.egressRate * regionMultiplier;

    const operationsCost = operationCostFor(provider, inputs);
    const minDurationDays = tier.minDays || provider.minDays || 0;
    const minDurationCost = minimumDurationCost(
      inputs.storageGB,
      tier.rate,
      minDurationDays,
      inputs.deletion,
    );

    const total = storageCost + egressCost + operationsCost + minDurationCost;

    return {
      provider,
      tier,
      storageCost,
      egressCost,
      operationsCost,
      minDurationCost,
      minDurationDays,
      total,
      freeEgressGB,
      billableEgressGB,
      billableStorageGB,
    };
  }

  function operationCostFor(provider, inputs) {
    if (provider.isB2 || provider.noOpsFee) return 0;

    if (provider.r2Ops) {
      const paidA = Math.max(0, inputs.classA - 1 * MILLION);
      const paidB = Math.max(0, inputs.classB - 10 * MILLION);
      return (paidA / MILLION) * 4.5 + (paidB / MILLION) * 0.36;
    }

    const rates = provider.opRates || { classA1000: 0, classB1000: 0, classC1000: 0 };
    return (
      (inputs.classA / 1000) * rates.classA1000 +
      (inputs.classB / 1000) * rates.classB1000 +
      (inputs.classC / 1000) * rates.classC1000
    );
  }

  function minimumDurationCost(storageGB, storageRate, minDays, deletion) {
    if (!minDays) return 0;
    const extraDays = Math.max(0, minDays - deletion.avgDaysHeld);
    if (!extraDays) return 0;
    const churnGB = storageGB * deletion.churn;
    return churnGB * storageRate * (extraDays / 30);
  }

  function getCosts() {
    const inputs = effectiveInputs();
    const costs = PROVIDERS.map((provider) => costFor(provider, inputs));
    return { inputs, costs, b2: costs.find((cost) => cost.provider.id === "b2") };
  }

  function periodMultiplier() {
    return state.period === "annual" ? 12 : 1;
  }

  function periodize(value) {
    return value * periodMultiplier();
  }

  /* ---------- Formatters ---------- */
  function fmtMoney(value) {
    const rounded = Math.abs(value) >= 1000 ? 0 : Math.abs(value) >= 100 ? 0 : 2;
    return value.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: rounded,
      minimumFractionDigits: rounded === 2 && Math.abs(value) < 10 ? 2 : 0,
    });
  }

  function trimNumber(value) {
    return value.toFixed(value >= 10 ? 1 : 2).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
  }

  function fmtData(gb) {
    if (!Number.isFinite(gb)) return "Unlimited";
    const tb = gb / GB_PER_TB;
    if (tb >= TB_PER_PB) return `${trimNumber(tb / TB_PER_PB)} PB`;
    if (tb >= 1) return `${trimNumber(tb)} TB`;
    return `${Math.round(gb).toLocaleString("en-US")} GB`;
  }

  function fmtPercent(value) {
    return `${Math.round(value).toLocaleString("en-US")}%`;
  }

  /* ---------- Render ---------- */
  function render() {
    const { inputs, costs, b2 } = getCosts();
    const compare = costs.find((cost) => cost.provider.id === state.compare) || costs[1];
    const savings = compare.total - b2.total;
    const savingsPct = compare.total > 0 ? (savings / compare.total) * 100 : 0;
    const periodText = state.period === "annual" ? "annual" : "monthly";

    syncControls(inputs);

    els.periodLabel.textContent = periodText;
    els.b2TotalLarge.textContent = fmtMoney(periodize(b2.total));
    els.savings.textContent = fmtMoney(Math.abs(periodize(savings)));
    els.savingsPercent.textContent = fmtPercent(Math.abs(savingsPct));
    els.freeEgress.textContent = fmtData(b2.freeEgressGB);
    els.savingsCopy.textContent =
      savings >= 0
        ? `B2 is modeled ${fmtMoney(periodize(savings))} lower than ${compare.provider.name} for this ${periodText} scenario.`
        : `This scenario models B2 ${fmtMoney(Math.abs(periodize(savings)))} higher than ${compare.provider.name}; check tier and deletion assumptions.`;

    if (els.liveSummary) {
      els.liveSummary.textContent =
        savings >= 0
          ? `Backblaze B2 estimate ${fmtMoney(periodize(b2.total))} ${periodText}, ${fmtPercent(Math.abs(savingsPct))} lower than ${compare.provider.name}.`
          : `Backblaze B2 estimate ${fmtMoney(periodize(b2.total))} ${periodText}, ${fmtPercent(Math.abs(savingsPct))} higher than ${compare.provider.name}.`;
    }

    renderB2Lines(b2, compare, inputs);
    renderCompareChart(costs);
    renderProviderCards(costs, inputs);
    renderAdvancedOutput(b2, compare, inputs);
    renderAssumptions(costs, inputs);
  }

  function syncControls(inputs) {
    syncThemeButtons();
    if (els.styleSelect) els.styleSelect.value = state.style;

    els.billingButtons.forEach((button) => {
      const active = button.dataset.billing === state.period;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });

    els.presetButtons.forEach((button) => {
      const active = button.dataset.workload === state.workload;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });

    els.storageUnit.value = state.storageUnit;
    setInputValue(els.storageValue, trimInput(state.storageTB));
    els.storageRange.value = Math.min(Number(els.storageRange.max), Math.max(1, state.storageTB));
    setRangeProgress(els.storageRange);

    setInputValue(els.egressValue, trimInput(state.egressPct));
    els.egressRange.value = Math.min(Number(els.egressRange.max), Math.max(0, state.egressPct));
    setRangeProgress(els.egressRange);
    const egressProgress = Math.min(100, (state.egressPct / 500) * 100);
    const egressPaidStart = Math.min(egressProgress, 60);
    els.egressRange.style.setProperty("--egress-paid-start", `${egressPaidStart}%`);
    els.egressProgress.style.setProperty("--egress-progress", `${egressProgress}%`);
    els.egressProgress.style.setProperty("--egress-paid-start", `${egressPaidStart}%`);

    els.egressNote.textContent =
      state.egressPct <= 300
        ? `B2 covers ${fmtData(inputs.egressGB)} of egress in this scenario because it is within the 3× free allowance.`
        : `B2 covers ${fmtData(inputs.storageGB * 3)} and bills ${fmtData(inputs.egressGB - inputs.storageGB * 3)} at the modeled egress rate.`;

    const draft = state.advancedDraft;
    setInputValue(els.classA, trimInput(draft.classA));
    setInputValue(els.classB, trimInput(draft.classB));
    setInputValue(els.classC, trimInput(draft.classC));
    els.deletion.value = draft.deletion;
    els.region.value = draft.region;
    els.tierProfile.value = draft.tierProfile;
    setInputValue(els.annualGrowth, trimInput(draft.growthPct));

    els.advancedStatus.textContent = state.advancedUnlocked
      ? "Advanced active"
      : "Using workload defaults";
    els.advancedStatus.classList.toggle("muted", !state.advancedUnlocked);
    els.printReport.disabled = !state.advancedUnlocked;
    els.compareProvider.value = state.compare;
  }

  function trimInput(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "0";
    if (Math.abs(numeric - Math.round(numeric)) < 0.001) return String(Math.round(numeric));
    return String(Number(numeric.toFixed(2)));
  }

  // Write a synced value back to an input ONLY when it is not the field being
  // edited, so live typing (decimals, clearing) is never clobbered.
  function setInputValue(el, value) {
    if (el !== document.activeElement) el.value = value;
  }

  function setRangeProgress(range) {
    const min = Number(range.min) || 0;
    const max = Number(range.max) || 100;
    const value = Number(range.value) || 0;
    const pct = ((value - min) / (max - min)) * 100;
    range.style.setProperty("--range-progress", `${Math.max(0, Math.min(100, pct))}%`);
  }

  function renderB2Lines(b2, compare, inputs) {
    const minSavings = compare.minDurationCost - b2.minDurationCost;
    const lines = [
      {
        label: "Storage",
        value: fmtMoney(periodize(b2.storageCost)),
        note: `${fmtData(inputs.storageGB)} stored at the modeled B2 PAYG rate.`,
      },
      {
        label: "Egress",
        value: fmtMoney(periodize(b2.egressCost)),
        zero: b2.egressCost === 0,
        badge: b2.egressCost === 0 ? "Included" : "",
        note:
          b2.egressCost === 0
            ? `${fmtData(inputs.egressGB)} covered by the 3× stored-data allowance.`
            : `${fmtData(b2.billableEgressGB)} billed after the 3× stored-data allowance.`,
      },
      {
        label: "Transactions",
        value: "$0",
        zero: true,
        badge: "Free",
        note: "Class A, B, and C operations are modeled as free on B2 PAYG.",
      },
      {
        label: "Min. duration fees",
        value: "$0",
        zero: true,
        badge: "$0",
        note:
          minSavings > 0
            ? `Avoids ${fmtMoney(periodize(minSavings))} vs. ${compare.provider.name} with ${inputs.deletion.label.toLowerCase()} deletion.`
            : "No 30, 90, or 180 day storage duration floor.",
      },
      {
        label: "Minimum file size",
        value: "$0",
        zero: true,
        badge: "$0",
        note: "No minimum object-size fee is modeled for B2.",
      },
    ];

    els.b2Lines.innerHTML = lines
      .map(
        (line) => `
          <article class="line-card ${line.zero ? "is-zero" : ""}">
            ${line.badge ? `<span class="line-badge">${line.badge}</span>` : ""}
            <span class="line-label">${line.label}</span>
            <strong class="line-value">${line.value}</strong>
            <p class="line-note">${line.note}</p>
          </article>
        `,
      )
      .join("");
  }

  function renderCompareChart(costs) {
    const maxTotal = Math.max(...costs.map((cost) => cost.total), 1);

    els.compareChart.innerHTML = costs
      .map((cost) => {
        const provider = cost.provider;
        const width = Math.max(3, (cost.total / maxTotal) * 100);
        const styleVars = `--provider-accent:${provider.accent};--provider-accent-strong:${provider.accentStrong}`;
        return `
          <div class="cc-row ${provider.isB2 ? "is-b2" : ""}" style="${styleVars}">
            <span class="cc-label">${provider.name}</span>
            <span class="cc-track"><span class="cc-fill" style="--w:${width}%"></span></span>
            <span class="cc-value">${fmtMoney(periodize(cost.total))}<small class="cc-period">/${state.period === "annual" ? "yr" : "mo"}</small></span>
          </div>
        `;
      })
      .join("");
  }

  function renderProviderCards(costs, inputs) {
    els.providerCards.innerHTML = costs
      .map((cost) => providerCardTemplate(cost, inputs))
      .join("");
  }

  function providerCardTemplate(cost, inputs) {
    const provider = cost.provider;
    const lines = [
      { label: "Storage", value: cost.storageCost, free: false },
      {
        label: "Egress",
        value: cost.egressCost,
        free: cost.egressCost === 0,
        note: Number.isFinite(cost.freeEgressGB) ? `${fmtData(cost.freeEgressGB)} free` : "No egress fee",
      },
      { label: "Operations", value: cost.operationsCost, free: cost.operationsCost === 0 },
      {
        label: "Min. duration",
        value: cost.minDurationCost,
        free: cost.minDurationCost === 0,
        note: cost.minDurationDays ? `${cost.minDurationDays}-day floor` : "No floor",
      },
    ];

    const styleVars = `--provider-accent:${provider.accent};--provider-accent-strong:${provider.accentStrong}`;

    return `
      <article class="provider-card ${provider.isB2 ? "is-b2" : ""} ${
        provider.id === state.compare ? "is-selected" : ""
      }" style="${styleVars}">
        <div class="pc-head">
          <div class="pc-logo-full">
            <img src="${provider.logo}" alt="${provider.name}" loading="eager" />
          </div>
          <span class="pc-service">${provider.name}</span>
          <div class="pc-total">
            <strong>${fmtMoney(periodize(cost.total))}</strong>
            <span>${state.period === "annual" ? "per year" : "per month"}</span>
          </div>
        </div>
        <ul class="pc-lines">
          ${lines
            .map(
              (line) => `
                <li class="${line.free ? "is-free" : ""}">
                  <span>${line.label}${line.note ? ` <small>(${line.note})</small>` : ""}</span>
                  <strong>${fmtMoney(periodize(line.value))}</strong>
                </li>
              `,
            )
            .join("")}
        </ul>
        <p class="pc-foot">${providerFootnote(cost, inputs)}</p>
      </article>
    `;
  }

  function providerFootnote(cost, inputs) {
    if (cost.provider.isB2) {
      return `Includes ${fmtData(cost.freeEgressGB)} of free egress and no modeled request fees.`;
    }
    if (cost.provider.id === "r2") {
      return "Uses R2 free operation thresholds and zero modeled egress fees.";
    }
    return `${inputs.region.label}; ${inputs.tierProfile === "auto" ? "workload-aligned" : inputs.tierProfile} tiering.`;
  }

  function renderAdvancedOutput(b2, compare, inputs) {
    if (!state.advancedUnlocked) {
      els.advancedOutput.hidden = true;
      els.projectionCards.innerHTML = "";
      return;
    }

    const projection = threeYearProjection(b2.provider, compare.provider, inputs);
    els.advancedOutput.hidden = false;
    const cards = [
      {
        label: "Year 1 B2 cost",
        value: fmtMoney(projection.years[0].b2Annual),
        note: `${fmtData(projection.years[0].storageGB)} average stored data.`,
      },
      {
        label: "Year 3 B2 cost",
        value: fmtMoney(projection.years[2].b2Annual),
        note: `${fmtPercent(inputs.growthPct)} annual data growth applied.`,
      },
      {
        label: "Three-year savings",
        value: fmtMoney(projection.totalSavings),
        note: `Compared with ${compare.provider.name} using the selected assumptions.`,
      },
      {
        label: "Min. duration avoided",
        value: fmtMoney(projection.minDurationAvoided),
        note: `${inputs.deletion.label} deletion pattern across the projection.`,
      },
    ];

    els.projectionCards.innerHTML = cards
      .map(
        (card) => `
          <article class="projection-card">
            <span>${card.label}</span>
            <strong>${card.value}</strong>
            <p>${card.note}</p>
          </article>
        `,
      )
      .join("");
  }

  function threeYearProjection(b2Provider, compareProvider, inputs) {
    const growthRate = Math.max(0, inputs.growthPct) / 100;
    const years = [0, 1, 2].map((index) => {
      const multiplier = (1 + growthRate) ** index;
      const projectedInputs = {
        ...inputs,
        storageGB: inputs.storageGB * multiplier,
        storageTB: inputs.storageTB * multiplier,
        egressGB: inputs.egressGB * multiplier,
        classA: inputs.classA * multiplier,
        classB: inputs.classB * multiplier,
        classC: inputs.classC * multiplier,
      };
      const b2Cost = costFor(b2Provider, projectedInputs);
      const compareCost = costFor(compareProvider, projectedInputs);
      return {
        year: index + 1,
        storageGB: projectedInputs.storageGB,
        b2Annual: b2Cost.total * 12,
        compareAnnual: compareCost.total * 12,
        annualSavings: (compareCost.total - b2Cost.total) * 12,
        minDurationAvoided: Math.max(0, compareCost.minDurationCost - b2Cost.minDurationCost) * 12,
      };
    });

    return {
      years,
      totalSavings: years.reduce((sum, year) => sum + year.annualSavings, 0),
      minDurationAvoided: years.reduce((sum, year) => sum + year.minDurationAvoided, 0),
    };
  }

  function renderAssumptions(costs, inputs) {
    els.assumptions.innerHTML = costs
      .map((cost) => {
        const provider = cost.provider;
        const storageModel = provider.tiers
          ? `${cost.tier.label} at ${fmtRate(cost.tier.rate)} / GB-month`
          : provider.storageLabel;
        const minModel = cost.minDurationDays
          ? `${cost.minDurationDays} day floor; ${inputs.deletion.summary}`
          : "No modeled minimum duration fee";
        return `
          <tr>
            <td>
              <span class="assumption-provider" style="--provider-accent:${provider.accent}">
                ${provider.name}
              </span>
            </td>
            <td>${storageModel}</td>
            <td>${provider.egressLabel}</td>
            <td>${provider.operationsLabel}</td>
            <td>${minModel}</td>
          </tr>
        `;
      })
      .join("");
  }

  function fmtRate(value) {
    if (!value) return "$0";
    return `$${value.toFixed(value < 0.01 ? 5 : 4).replace(/0+$/, "").replace(/\.$/, "")}`;
  }

  /* ---------- Interactions ---------- */
  function setWorkload(workload) {
    if (!WORKLOADS[workload]) return;
    const preset = WORKLOADS[workload];
    state.workload = workload;
    state.storageTB = preset.storageTB;
    state.egressPct = preset.egressPct;
    state.advancedDraft = draftFromWorkload(workload);
    render();
  }

  function updateStorageFromDisplay() {
    const raw = Math.max(0, Number(els.storageValue.value) || 0);
    state.storageUnit = els.storageUnit.value;
    state.storageTB = raw;
    render();
  }

  function updateAdvancedDraftFromControls() {
    state.advancedDraft = {
      classA: Math.max(0, Number(els.classA.value) || 0),
      classB: Math.max(0, Number(els.classB.value) || 0),
      classC: Math.max(0, Number(els.classC.value) || 0),
      deletion: els.deletion.value,
      region: els.region.value,
      tierProfile: els.tierProfile.value,
      growthPct: Math.max(0, Number(els.annualGrowth.value) || 0),
    };
  }

  let gateOpener = null;

  function openGate() {
    gateOpener = document.activeElement;
    if (typeof els.gateModal.showModal === "function") {
      els.gateModal.showModal();
    } else {
      els.gateModal.setAttribute("open", "");
    }
    // showModal() synchronously focuses the dialog's first control; move focus
    // to the email field right after (runs synchronously, so it sticks).
    const email = $("#lead-email");
    if (email) email.focus();
  }

  function closeGate() {
    if (typeof els.gateModal.close === "function") {
      els.gateModal.close();
    } else {
      els.gateModal.removeAttribute("open");
      restoreGateFocus();
    }
  }

  function restoreGateFocus() {
    if (gateOpener && typeof gateOpener.focus === "function") gateOpener.focus();
    gateOpener = null;
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("is-visible");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      els.toast.classList.remove("is-visible");
    }, 2600);
  }

  function buildShareUrl() {
    const params = new URLSearchParams({
      workload: state.workload,
      storageTB: trimInput(state.storageTB),
      egressPct: trimInput(state.egressPct),
      period: state.period,
      compare: state.compare,
      unit: state.storageUnit,
    });
    return `${window.location.origin}${window.location.pathname}#${params.toString()}`;
  }

  async function copyScenario() {
    const url = buildShareUrl();
    window.history.replaceState(null, "", url);
    try {
      await navigator.clipboard.writeText(url);
      showToast("Scenario link copied.");
    } catch {
      showToast("Scenario link is in the address bar.");
    }
  }

  function downloadPdfReport() {
    const { inputs, costs, b2 } = getCosts();
    const compare = costs.find((cost) => cost.provider.id === state.compare) || costs[1];
    const projection = threeYearProjection(b2.provider, compare.provider, inputs);
    const pdf = buildPdfReport(inputs, costs, b2, compare, projection);
    const blob = new Blob([pdf], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "backblaze-b2-payg-cost-estimate.pdf";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("PDF report downloaded.");
  }

  function buildPdfReport(inputs, costs, b2, compare, projection) {
    const lines = [
      { text: "Backblaze B2 PAYG Cost Estimate", size: 20, bold: true, gap: 24 },
      { text: `Generated ${new Date().toLocaleDateString("en-US")}`, size: 9, gap: 18 },
      { text: "Scenario", size: 14, bold: true, gap: 18 },
      { text: `Workload: ${inputs.workloadLabel}` },
      { text: `Stored data: ${fmtData(inputs.storageGB)}` },
      { text: `Monthly egress: ${fmtPercent(state.egressPct)} (${fmtData(inputs.egressGB)})` },
      { text: `Deletion frequency: ${inputs.deletion.label}` },
      { text: `Region comparison: ${inputs.region.label}` },
      { text: `Annual data growth: ${fmtPercent(inputs.growthPct)}`, gap: 18 },
      { text: "Estimated Costs", size: 14, bold: true, gap: 18 },
      { text: `Backblaze B2 monthly estimate: ${fmtMoney(b2.total)}` },
      { text: `${compare.provider.name} monthly estimate: ${fmtMoney(compare.total)}` },
      { text: `Monthly savings vs. ${compare.provider.name}: ${fmtMoney(compare.total - b2.total)}`, gap: 18 },
      { text: "B2 Cost Lines", size: 14, bold: true, gap: 18 },
      { text: `Storage: ${fmtMoney(b2.storageCost)}` },
      { text: `Egress: ${fmtMoney(b2.egressCost)} (${fmtData(b2.freeEgressGB)} included)` },
      { text: "Transactions: $0.00" },
      { text: "Minimum duration fees: $0.00" },
      { text: "Minimum file size fees: $0.00", gap: 18 },
      { text: "Three-Year Outlook", size: 14, bold: true, gap: 18 },
      ...projection.years.map((year) => ({
        text: `Year ${year.year}: B2 ${fmtMoney(year.b2Annual)} vs. ${compare.provider.name} ${fmtMoney(year.compareAnnual)}; savings ${fmtMoney(year.annualSavings)}`,
      })),
      { text: `Total three-year savings: ${fmtMoney(projection.totalSavings)}`, bold: true, gap: 18 },
      { text: "Provider Comparison", size: 14, bold: true, gap: 18 },
      ...costs.map((cost) => ({
        text: `${cost.provider.name}: ${fmtMoney(cost.total)} monthly (${cost.tier.label})`,
      })),
      { text: "Notes", size: 14, bold: true, gap: 18 },
      {
        text:
          "This estimate uses static list-rate assumptions for planning. Actual billing can vary by usage pattern, region, contract terms, discounts, taxes, and rate-card updates.",
      },
    ];

    return createPdf(lines);
  }

  function createPdf(lines) {
    const pageWidth = 612;
    const pageHeight = 792;
    const margin = 54;
    const lineHeight = 14;
    const maxChars = 92;
    const pages = [];
    let page = [];
    let y = pageHeight - margin;

    const newPage = () => {
      if (page.length) pages.push(page);
      page = [];
      y = pageHeight - margin;
    };

    lines.forEach((line) => {
      const wrapped = wrapPdfText(line.text, line.size >= 14 ? 70 : maxChars);
      wrapped.forEach((text, index) => {
        const size = line.size || 10;
        const gap = index === wrapped.length - 1 ? line.gap || lineHeight : lineHeight;
        if (y < margin + gap) newPage();
        page.push({ text, y, size, bold: Boolean(line.bold) });
        y -= gap;
      });
    });
    newPage();

    const objects = [];
    const addObject = (value) => {
      objects.push(value);
      return objects.length;
    };

    const catalogId = addObject("<< /Type /Catalog /Pages 2 0 R >>");
    const pagesId = addObject("");
    const fontRegularId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    const fontBoldId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
    const pageIds = [];

    pages.forEach((pageLines) => {
      const stream = pageLines
        .map((line) => {
          const font = line.bold ? "F2" : "F1";
          return `BT /${font} ${line.size} Tf ${margin} ${line.y} Td (${escapePdfText(line.text)}) Tj ET`;
        })
        .join("\n");
      const pageId = objects.length + 1;
      const contentId = objects.length + 2;
      pageIds.push(pageId);
      addObject(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      );
      addObject(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    });

    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds
      .map((id) => `${id} 0 R`)
      .join(" ")}] /Count ${pageIds.length} >>`;

    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((object, index) => {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.slice(1).forEach((offset) => {
      pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    });
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return pdf;
  }

  function wrapPdfText(text, maxChars) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = "";
    words.forEach((word) => {
      if ((line ? `${line} ${word}` : word).length > maxChars) {
        if (line) lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    });
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }

  function escapePdfText(text) {
    return String(text)
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "-")
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  }

  function buildLeadPayload() {
    const { inputs, costs, b2 } = getCosts();
    const compare = costs.find((cost) => cost.provider.id === state.compare) || costs[1];
    return {
      event: "b2_payg_advanced_unlocked",
      email: $("#lead-email").value.trim(),
      company: $("#lead-company").value.trim(),
      timeframe: $("#lead-timeframe").value,
      workload: inputs.workloadLabel,
      storageTB: Number(trimInput(inputs.storageTB)),
      egressPct: state.egressPct,
      compareProvider: compare.provider.name,
      b2MonthlyEstimate: Number(b2.total.toFixed(2)),
      compareMonthlyEstimate: Number(compare.total.toFixed(2)),
      monthlySavings: Number((compare.total - b2.total).toFixed(2)),
      advanced: {
        classAMillions: state.advancedDraft.classA,
        classBMillions: state.advancedDraft.classB,
        classCMillions: state.advancedDraft.classC,
        deletionFrequency: state.advancedDraft.deletion,
        region: state.advancedDraft.region,
        tierProfile: state.advancedDraft.tierProfile,
        annualGrowthPct: state.advancedDraft.growthPct,
      },
    };
  }

  async function publishLead(payload) {
    window.dispatchEvent(new CustomEvent("b2-calculator-lead", { detail: payload }));
    if (Array.isArray(window.dataLayer)) {
      window.dataLayer.push(payload);
    }

    if (!window.B2_CALCULATOR_LEAD_ENDPOINT) return;

    try {
      await fetch(window.B2_CALCULATOR_LEAD_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      });
    } catch {
      // The advanced model should still unlock if the downstream integration is unavailable.
    }
  }

  function bindEvents() {
    els.billingButtons.forEach((button) => {
      button.addEventListener("click", () => {
        state.period = button.dataset.billing === "annual" ? "annual" : "monthly";
        render();
      });
    });

    els.themeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        setThemeMode(button.dataset.themeChoice);
        closeThemeMenu();
        if (els.themeTrigger) els.themeTrigger.focus();
      });
    });

    if (els.themeTrigger) {
      els.themeTrigger.addEventListener("click", (event) => {
        event.stopPropagation();
        setThemeMenu(els.themePopover.hidden);
      });
    }
    document.addEventListener("click", (event) => {
      if (els.themeMenu && !els.themeMenu.contains(event.target)) closeThemeMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && els.themePopover && !els.themePopover.hidden) {
        closeThemeMenu();
        if (els.themeTrigger) els.themeTrigger.focus();
      }
    });

    if (els.styleSelect) {
      els.styleSelect.addEventListener("change", () => {
        setStyle(els.styleSelect.value);
      });
    }

    systemThemeQuery.addEventListener("change", () => {
      if (state.themeMode === "system") setThemeMode("system", { persist: false });
    });

    els.presetButtons.forEach((button) => {
      button.addEventListener("click", () => setWorkload(button.dataset.workload));
    });

    els.storageValue.addEventListener("change", updateStorageFromDisplay);
    els.storageValue.addEventListener("input", updateStorageFromDisplay);
    els.storageUnit.addEventListener("change", updateStorageFromDisplay);
    els.storageRange.addEventListener("input", () => {
      const sliderTB = Number(els.storageRange.value);
      state.storageTB = sliderTB;
      render();
    });

    els.egressValue.addEventListener("input", () => {
      state.egressPct = Math.max(0, Math.min(500, Number(els.egressValue.value) || 0));
      render();
    });

    els.egressRange.addEventListener("input", () => {
      state.egressPct = Number(els.egressRange.value);
      render();
    });

    [
      els.classA,
      els.classB,
      els.classC,
      els.deletion,
      els.region,
      els.tierProfile,
      els.annualGrowth,
    ].forEach((el) => {
      const handler = () => {
        updateAdvancedDraftFromControls();
        if (state.advancedUnlocked) {
          render();
        } else {
          els.advancedStatus.textContent = "Advanced edits pending";
          els.advancedStatus.classList.remove("muted");
        }
      };
      el.addEventListener("input", handler);
      el.addEventListener("change", handler);
    });

    els.applyAdvanced.addEventListener("click", () => {
      updateAdvancedDraftFromControls();
      if (!state.advancedUnlocked) {
        openGate();
        return;
      }
      render();
      showToast("Advanced model applied.");
    });

    els.gateForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const email = $("#lead-email").value.trim();
      if (!email || !email.includes("@")) {
        $("#lead-email").focus();
        return;
      }
      const payload = buildLeadPayload();
      state.advancedUnlocked = true;
      publishLead(payload);
      closeGate();
      render();
      showToast("Advanced model unlocked.");
    });

    els.closeGate.addEventListener("click", closeGate);
    els.gateModal.addEventListener("close", restoreGateFocus);

    els.printReport.addEventListener("click", () => {
      if (!state.advancedUnlocked) return;
      downloadPdfReport();
    });

    els.compareProvider.addEventListener("change", () => {
      state.compare = els.compareProvider.value;
      render();
    });

    els.shareScenario.addEventListener("click", copyScenario);
  }

  readHash();
  bindEvents();
  setStyle(state.style, { persist: false });
  setThemeMode(state.themeMode, { persist: false });
  render();
})();
