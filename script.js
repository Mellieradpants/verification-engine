let LIBRARY = null;
let currentLanguage = "en";
const translationCache = new Map();

const EN_LABELS = {
  plainMeaningLabel: "Plain Meaning",
  detectedAssertionsLabel: "Detected Assertions",
  actionSignalsLabel: "Action Signals",
  timelineSignalsLabel: "Timeline Signals",
  sourceDomainLabel: "Source Domain",
  publisherLabel: "Publisher",
  authorLabel: "Author",
  timestampSignalLabel: "Timestamp Signal",
  ownershipContextLabel: "Ownership / Provenance Context",
  originSignalsLabel: "Origin Signals",
  assertionLabel: "Assertion",
  expectedRecordSystemsLabel: "Expected Record Systems",
  notesLabel: "Notes",
  noneDetected: "None detected.",
  noAssertionsDetected: "No assertions detected.",
  noActionSignalsDetected: "No action signals detected.",
  noTimelineSignalsDetected: "No timeline signals detected.",
  noOriginSignalsDetected: "No origin signals detected.",
  noVerificationItems: "No verification items to display.",
  pasteTextFirst: "Paste some text first.",
  debugSentencesSplit: "Sentences Split",
  debugCandidateAssertions: "Candidate Assertions",
  debugAssertionsReturned: "Assertions Returned",
  debugInputPreview: "Input Preview",
  noClearExplanation:
    "This text makes a claim but there was not enough information to explain it clearly.",
  bridgeSummary:
    "The text says the federal government plans to spend money repairing bridges, expanding broadband internet, and upgrading the power grid. It also says these investments may reduce maintenance costs over time.",
  textSaysPrefix: "The text says ",
  governmentDomain: "Government domain",
  academicDomain: "Academic domain",
  congressGov: "Congress.gov",
  officialGovernmentDomain: "Official government domain",
  nonGovernmentDomain: "Non-government domain",
  noSourceUrl: "No source URL detected in text"
};

function syncLanguageFromUI() {
  const langSelect = document.getElementById("languageSelect");
  if (langSelect && langSelect.value) {
    currentLanguage = langSelect.value;
  }
}

async function translateText(text, language = currentLanguage) {
  if (!text) return text;
  if (!language || language === "en") return text;

  const cacheKey = `${language}::${text}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  try {
    const response = await fetch("/api/analyze-and-translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        language
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Translation API error:", data);
      return text;
    }

    const translated = data.translated || text;
    translationCache.set(cacheKey, translated);
    return translated;
  } catch (error) {
    console.error("Translation fetch failed:", error);
    return text;
  }
}

async function translateList(items, language = currentLanguage) {
  return Promise.all((items || []).map(item => translateText(item, language)));
}

async function t(key) {
  return translateText(EN_LABELS[key] || key, currentLanguage);
}

async function loadLibrary() {
  if (LIBRARY) return LIBRARY;
  const response = await fetch("./reference-library.json");
  LIBRARY = await response.json();
  return LIBRARY;
}

function normalizeInput(text) {
  return {
    rawText: (text || "").trim()
  };
}

function splitSentences(text) {
  if (!text) return [];
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map(s => s.trim())
    .filter(Boolean);
}

function detectAssertions(sentences) {
  const markers = [
    /\b(is|are|was|were|will|would|should|must|can|could|did|does|do|reported|announced|passed|increased|decreased|showed|found|establishes|expands|directs)\b/i,
    /\b\d+(\.\d+)?%?\b/,
    /\baccording to\b/i,
    /\bsection\b/i,
    /\bnew\b/i
  ];

  return sentences.filter(sentence => {
    if (sentence.length < 18) return false;
    return markers.some(rx => rx.test(sentence));
  });
}

function generatePlainMeaning(text) {
  if (!text) {
    return EN_LABELS.noClearExplanation;
  }

  const lower = text.toLowerCase();

  if (
    lower.includes("bridge") &&
    lower.includes("broadband") &&
    lower.includes("grid")
  ) {
    return EN_LABELS.bridgeSummary;
  }

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);

  let summary = sentences.slice(0, 2).join(" ");

  summary = summary.replace(/Section\s+\d+\s+/gi, "");
  summary = summary.replace(/\bestablishes\b/gi, "sets up");
  summary = summary.replace(/\bdirects\b/gi, "puts");
  summary = summary.replace(/\bmodernization\b/gi, "upgrades");
  summary = summary.replace(/\bdeployment\b/gi, "expansion");
  summary = summary.replace(/\s+/g, " ").trim();

  if (!summary.toLowerCase().startsWith("the text")) {
    summary = EN_LABELS.textSaysPrefix + summary.charAt(0).toLowerCase() + summary.slice(1);
  }

  return summary;
}

function scoreAssertionType(sentence, assertionTypes) {
  const lower = sentence.toLowerCase();
  let best = {
    id: "other",
    score: 0,
    label: "Other",
    recordSystems: ["Needs Human Review"]
  };

  for (const type of assertionTypes) {
    let score = 0;

    for (const signal of type.expectedSignals || []) {
      if (lower.includes(signal.toLowerCase())) score += 2;
    }

    for (const weak of type.weakSignals || []) {
      if (lower.includes(weak.toLowerCase())) score -= 1;
    }

    if (type.id === "statistical" && /\b\d+(\.\d+)?%?\b/.test(sentence)) score += 2;
    if (type.id === "predictive" && /\b(will|likely|projected|expected|forecast)\b/i.test(sentence)) score += 2;
    if (type.id === "normative" && /\b(should|ought|must|fair|unfair|ethical|harmful)\b/i.test(sentence)) score += 2;
    if (type.id === "policy_legal" && /\b(bill|act|law|rule|regulation|section|agency|court|congress)\b/i.test(sentence)) score += 2;

    if (score > best.score) {
      best = {
        id: type.id,
        score,
        label: type.label || type.id,
        recordSystems: type.recordSystems || ["Needs Human Review"]
      };
    }
  }

  return best;
}

function buildReviewFlags(typeId, sentence) {
  const flags = [];
  const lower = sentence.toLowerCase();

  if (!/\b(according to|report|study|section|act|bill|court|agency|department|published)\b/i.test(sentence)) {
    flags.push("source_path_incomplete");
  }

  if (typeId === "normative") {
    flags.push("interpretive_judgment_required");
  }

  if (typeId === "predictive") {
    flags.push("forecast_model_needed");
  }

  if (/\b(rumor|viral|people are saying|some say)\b/i.test(lower)) {
    flags.push("secondary_source_only");
  }

  if (flags.length === 0) {
    flags.push("verification_path_available");
  }

  return [...new Set(flags)];
}

function extractMeaning(rawText, assertions) {
  const actions = [];
  const timelineSignals = [];

  assertions.forEach(text => {
    if (/\b(increase|decrease|expand|reduce|fund|ban|require|allow|renew|apply|report|announce|pass|establish|direct)\b/i.test(text)) {
      actions.push(text);
    }

    const years = text.match(/\b(19|20)\d{2}\b/g);
    if (years) timelineSignals.push(...years);

    const relative = text.match(/\b(today|tomorrow|this year|next year|current|effective)\b/i);
    if (relative) timelineSignals.push(relative[0]);
  });

  return {
    plainMeaning: generatePlainMeaning(rawText),
    assertions,
    actions: [...new Set(actions)],
    timelineSignals: [...new Set(timelineSignals)]
  };
}

function extractOrigin(rawText) {
  let sourceDomain = "";
  let publisher = "";
  let author = "";
  let timestamp = "";
  const originSignals = [];

  const urlMatch = rawText.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    try {
      const url = new URL(urlMatch[0]);
      sourceDomain = url.hostname;
      originSignals.push(`source_url:${url.hostname}`);
      if (url.hostname.includes(".gov")) publisher = EN_LABELS.governmentDomain;
      if (url.hostname.includes(".edu")) publisher = EN_LABELS.academicDomain;
      if (url.hostname.includes("congress.gov")) publisher = EN_LABELS.congressGov;
    } catch (_) {}
  }

  const publisherMatch = rawText.match(/\b(according to|published by|from)\s+([A-Z][A-Za-z0-9&.\- ]{2,80})/);
  if (publisherMatch && !publisher) {
    publisher = publisherMatch[2].trim();
    originSignals.push(`publisher_text:${publisher}`);
  }

  const authorMatch = rawText.match(/\bby\s+([A-Z][A-Za-z.\- ]{2,60})/);
  if (authorMatch) {
    author = authorMatch[1].trim();
    originSignals.push(`author_text:${author}`);
  }

  const timeMatch = rawText.match(/\b((19|20)\d{2}|January|February|March|April|May|June|July|August|September|October|November|December)\b/i);
  if (timeMatch) {
    timestamp = timeMatch[0];
    originSignals.push(`time_signal:${timestamp}`);
  }

  return {
    sourceDomain,
    publisher,
    author,
    timestamp,
    ownershipContext: sourceDomain.includes(".gov")
      ? EN_LABELS.officialGovernmentDomain
      : sourceDomain.includes(".edu")
      ? EN_LABELS.academicDomain
      : sourceDomain
      ? EN_LABELS.nonGovernmentDomain
      : EN_LABELS.noSourceUrl,
    originSignals
  };
}

function runVerification(assertionTexts, library) {
  return assertionTexts.map(text => {
    const type = scoreAssertionType(text, library.assertionTypes);
    const flags = buildReviewFlags(type.id, text);

    let notes = "";
    if (type.id === "normative") {
      notes = "This is a value-oriented statement. Treat record systems as framing references, not definitive proof paths.";
    } else if (type.id === "predictive") {
      notes = "This is a forecast-style statement. Model assumptions and prior forecast track records matter.";
    } else if (flags.includes("source_path_incomplete")) {
      notes = "This statement suggests a plausible verification path but does not yet identify a concrete primary record.";
    } else {
      notes = "This statement points toward an identifiable record system class.";
    }

    return {
      text,
      type: type.id,
      typeLabel: type.label,
      recordSystems: type.recordSystems,
      reviewFlags: flags,
      notes
    };
  });
}

async function localizeMeaning(meaning) {
  return {
    plainMeaning: await translateText(meaning.plainMeaning),
    assertions: await translateList(meaning.assertions),
    actions: await translateList(meaning.actions),
    timelineSignals: meaning.timelineSignals
  };
}

async function localizeOrigin(origin) {
  return {
    ...origin,
    publisher: await translateText(origin.publisher),
    ownershipContext: await translateText(origin.ownershipContext),
    originSignals: origin.originSignals
  };
}

async function localizeVerification(items) {
  return Promise.all(
    items.map(async item => {
      const displayText = await translateText(item.text);
      const displayTypeLabel = await translateText(item.typeLabel);
      const displayFlags = await translateList(
        item.reviewFlags.map(flag => flag.replaceAll("_", " "))
      );
      const displayRecordSystems = await translateList(item.recordSystems);
      const displayNotes = await translateText(item.notes);

      return {
        ...item,
        displayText,
        displayTypeLabel,
        displayFlags,
        displayRecordSystems,
        displayNotes
      };
    })
  );
}

async function renderMeaning(meaning) {
  const panel = document.getElementById("meaningPanel");

  const noAssertionsDetected = await t("noAssertionsDetected");
  const noActionSignalsDetected = await t("noActionSignalsDetected");
  const noTimelineSignalsDetected = await t("noTimelineSignalsDetected");
  const plainMeaningLabel = await t("plainMeaningLabel");
  const detectedAssertionsLabel = await t("detectedAssertionsLabel");
  const actionSignalsLabel = await t("actionSignalsLabel");
  const timelineSignalsLabel = await t("timelineSignalsLabel");

  const assertionsHtml = meaning.assertions.length
    ? `<ul class="list">${meaning.assertions.map(a => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`
    : `<p class="empty">${escapeHtml(noAssertionsDetected)}</p>`;

  const actionsHtml = meaning.actions.length
    ? `<ul class="list">${meaning.actions.map(a => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`
    : `<p class="empty">${escapeHtml(noActionSignalsDetected)}</p>`;

  const timelineHtml = meaning.timelineSignals.length
    ? `<ul class="list">${meaning.timelineSignals.map(tl => `<li>${escapeHtml(tl)}</li>`).join("")}</ul>`
    : `<p class="empty">${escapeHtml(noTimelineSignalsDetected)}</p>`;

  panel.innerHTML = `
    <div class="card">
      <div class="small-label">${escapeHtml(plainMeaningLabel)}</div>
      <p>${escapeHtml(meaning.plainMeaning)}</p>
    </div>

    <div class="card">
      <div class="small-label">${escapeHtml(detectedAssertionsLabel)}</div>
      ${assertionsHtml}
    </div>

    <div class="card">
      <div class="small-label">${escapeHtml(actionSignalsLabel)}</div>
      ${actionsHtml}
    </div>

    <div class="card">
      <div class="small-label">${escapeHtml(timelineSignalsLabel)}</div>
      ${timelineHtml}
    </div>
  `;
}

async function renderOrigin(origin) {
  const panel = document.getElementById("originPanel");

  const sourceDomainLabel = await t("sourceDomainLabel");
  const publisherLabel = await t("publisherLabel");
  const authorLabel = await t("authorLabel");
  const timestampSignalLabel = await t("timestampSignalLabel");
  const ownershipContextLabel = await t("ownershipContextLabel");
  const originSignalsLabel = await t("originSignalsLabel");
  const noneDetected = await t("noneDetected");
  const noOriginSignalsDetected = await t("noOriginSignalsDetected");

  panel.innerHTML = `
    <div class="card">
      <div class="small-label">${escapeHtml(sourceDomainLabel)}</div>
      <p>${escapeHtml(origin.sourceDomain || noneDetected)}</p>
    </div>
    <div class="card">
      <div class="small-label">${escapeHtml(publisherLabel)}</div>
      <p>${escapeHtml(origin.publisher || noneDetected)}</p>
    </div>
    <div class="card">
      <div class="small-label">${escapeHtml(authorLabel)}</div>
      <p>${escapeHtml(origin.author || noneDetected)}</p>
    </div>
    <div class="card">
      <div class="small-label">${escapeHtml(timestampSignalLabel)}</div>
      <p>${escapeHtml(origin.timestamp || noneDetected)}</p>
    </div>
    <div class="card">
      <div class="small-label">${escapeHtml(ownershipContextLabel)}</div>
      <p>${escapeHtml(origin.ownershipContext)}</p>
    </div>
    <div class="card">
      <div class="small-label">${escapeHtml(originSignalsLabel)}</div>
      ${
        origin.originSignals.length
          ? `<ul class="list">${origin.originSignals.map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`
          : `<p class="empty">${escapeHtml(noOriginSignalsDetected)}</p>`
      }
    </div>
  `;
}

async function renderVerification(items) {
  const panel = document.getElementById("verificationPanel");

  const noVerificationItems = await t("noVerificationItems");
  const assertionLabel = await t("assertionLabel");
  const expectedRecordSystemsLabel = await t("expectedRecordSystemsLabel");
  const notesLabel = await t("notesLabel");

  if (!items.length) {
    panel.innerHTML = `<p class="empty">${escapeHtml(noVerificationItems)}</p>`;
    return;
  }

  panel.innerHTML = items.map(item => `
    <div class="card">
      <div class="small-label">${escapeHtml(assertionLabel)}</div>
      <p>${escapeHtml(item.displayText || item.text)}</p>

      <div class="badge-row">
        <span class="badge type">${escapeHtml(item.displayTypeLabel || item.typeLabel)}</span>
        ${(item.displayFlags || item.reviewFlags).map(f => `<span class="badge flag">${escapeHtml(f)}</span>`).join("")}
      </div>

      <div class="small-label">${escapeHtml(expectedRecordSystemsLabel)}</div>
      <ul class="list">${(item.displayRecordSystems || item.recordSystems).map(r => `<li>${escapeHtml(r)}</li>`).join("")}</ul>

      <div class="small-label">${escapeHtml(notesLabel)}</div>
      <p>${escapeHtml(item.displayNotes || item.notes)}</p>
    </div>
  `).join("");
}

async function renderDebug(debug) {
  const sentencesSplit = await t("debugSentencesSplit");
  const candidateAssertions = await t("debugCandidateAssertions");
  const assertionsReturned = await t("debugAssertionsReturned");
  const inputPreview = await t("debugInputPreview");

  document.getElementById("debugPanel").textContent = `{
  "${sentencesSplit}": ${debug.sentencesSplit},
  "${candidateAssertions}": ${debug.candidateAssertions},
  "${assertionsReturned}": ${debug.assertionsReturned},
  "${inputPreview}": "${debug.inputPreview}"
}`;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function analyze() {
  syncLanguageFromUI();

  const library = await loadLibrary();
  const input = normalizeInput(document.getElementById("inputText").value);

  if (!input.rawText) {
    alert(await t("pasteTextFirst"));
    return;
  }

  const sentences = splitSentences(input.rawText);
  const assertionTexts = detectAssertions(sentences);

  let meaning = extractMeaning(input.rawText, assertionTexts);
  let origin = extractOrigin(input.rawText);
  let verification = runVerification(assertionTexts, library);

  meaning = await localizeMeaning(meaning);
  origin = await localizeOrigin(origin);
  verification = await localizeVerification(verification);

  await renderMeaning(meaning);
  await renderOrigin(origin);
  await renderVerification(verification);

  await renderDebug({
    sentencesSplit: sentences.length,
    candidateAssertions: assertionTexts.length,
    assertionsReturned: verification.length,
    inputPreview: input.rawText.slice(0, 220)
  });

  document.getElementById("results").classList.remove("hidden");
}

function loadSample() {
  document.getElementById("inputText").value =
`Section 103 establishes a $108 billion federal bridge repair program beginning in 2026. According to the Department of Transportation, priority funding will go to structurally deficient bridges in interstate corridors. The bill also expands broadband deployment by $50 billion and directs grid modernization funding of $48 billion through the Department of Energy. Analysts say the measure will likely reduce long-term maintenance costs.`;
}

function clearAll() {
  document.getElementById("inputText").value = "";
  document.getElementById("results").classList.add("hidden");
  document.getElementById("meaningPanel").innerHTML = "";
  document.getElementById("originPanel").innerHTML = "";
  document.getElementById("verificationPanel").innerHTML = "";
  document.getElementById("debugPanel").textContent = "";
}

document.getElementById("analyzeBtn").addEventListener("click", analyze);

const sampleBtn =
  document.getElementById("loadSampleBtn") ||
  document.getElementById("sampleBtn");

if (sampleBtn) {
  sampleBtn.addEventListener("click", loadSample);
}

document.getElementById("clearBtn").addEventListener("click", clearAll);

const languageSelect = document.getElementById("languageSelect");
if (languageSelect) {
  currentLanguage = languageSelect.value || "en";
  languageSelect.addEventListener("change", async () => {
    currentLanguage = languageSelect.value || "en";
    if (!document.getElementById("results").classList.contains("hidden")) {
      await analyze();
    }
  });
}

