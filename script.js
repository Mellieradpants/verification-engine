
let LIBRARY = null;

async function loadLibrary() {
  if (LIBRARY) return LIBRARY;
  const response = await fetch('./reference-library.json');
  LIBRARY = await response.json();
  return LIBRARY;
}

function normalizeInput(text, sourceUrl) {
  return {
    rawText: (text || '').trim(),
    sourceUrl: (sourceUrl || '').trim()
  };
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map(s => s.trim())
    .filter(Boolean);
}

function detectAssertions(sentences) {
  const markers = [
    /\b(is|are|was|were|will|would|should|must|can|could|did|does|do|reported|announced|passed|increased|decreased|showed|found)\b/i,
    /\b\d+(\.\d+)?%?\b/,
    /\baccording to\b/i,
    /\bnew\b/i,
    /\bsection\b/i
  ];

  return sentences.filter(sentence => {
    if (sentence.length < 18) return false;
    return markers.some(rx => rx.test(sentence));
  });
}

function scoreAssertionType(sentence, assertionTypes) {
  const lower = sentence.toLowerCase();
  let best = { id: 'other', score: 0, label: 'Other', recordSystems: ['Needs Human Review'] };

  for (const type of assertionTypes) {
    let score = 0;
    for (const signal of (type.expectedSignals || [])) {
      if (lower.includes(signal.toLowerCase())) score += 2;
    }
    for (const weak of (type.weakSignals || [])) {
      if (lower.includes(weak.toLowerCase())) score -= 1;
    }

    // numeric bias toward statistical
    if (type.id === 'statistical' && /\b\d+(\.\d+)?%?\b/.test(sentence)) score += 2;
    if (type.id === 'predictive' && /\b(will|likely|projected|expected|forecast)\b/i.test(sentence)) score += 2;
    if (type.id === 'normative' && /\b(should|ought|must|fair|unfair|ethical|harmful)\b/i.test(sentence)) score += 2;
    if (type.id === 'policy_legal' && /\b(bill|act|law|rule|regulation|section|agency|court|congress)\b/i.test(sentence)) score += 2;

    if (score > best.score) {
      best = {
        id: type.id,
        score,
        label: type.label,
        recordSystems: type.recordSystems || ['Needs Human Review']
      };
    }
  }

  return best;
}

function buildReviewFlags(typeId, sentence) {
  const flags = [];
  const lower = sentence.toLowerCase();

  if (!/\b(https?:\/\/|according to|report|study|section|act|bill|court|agency|department|published)\b/i.test(sentence)) {
    flags.push('source_path_incomplete');
  }

  if (typeId === 'normative') {
    flags.push('interpretive_judgment_required');
  }

  if (typeId === 'predictive') {
    flags.push('forecast_model_needed');
  }

  if (/\b(some people say|people are saying|rumor|viral)\b/i.test(lower)) {
    flags.push('secondary_source_only');
  }

  if (!flags.length) {
    flags.push('verification_path_available');
  }

  return [...new Set(flags)];
  
}function extractMeaning(assertions) {
  const actions = [];
  const timelineSignals = [];
  const plainMeaning = assertions.length
    ? `The text contains ${assertions.length} assertion${assertions.length === 1 ? '' : 's'} that can be inspected for source, meaning, and verification paths.`
    : 'No clear assertions detected in the current text.';



  assertions.forEach(({ text }) => {
    if (/\b(increase|decrease|expand|reduce|fund|ban|require|allow|renew|apply|report|announce|pass)\b/i.test(text)) {
      actions.push(text);
    }
    const matches = text.match(/\b(19|20)\d{2}\b/g);
    if (matches) timelineSignals.push(...matches);
    if (/\b(today|tomorrow|this year|next year|current|effective)\b/i.test(text)) {
      timelineSignals.push(text.match(/\b(today|tomorrow|this year|next year|current|effective)\b/i)[0]);
    }
  });

  return {
    plainMeaning,
    assertions: assertions.map(a => a.text),
    actions: [...new Set(actions)],
    timelineSignals: [...new Set(timelineSignals)]
  };
}

function extractOrigin(sourceUrl, rawText) {
  let sourceDomain = '';
  let publisher = '';
  let author = '';
  let timestamp = '';
  const originSignals = [];

  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      sourceDomain = url.hostname;
      originSignals.push(`source_url:${url.hostname}`);
      if (url.hostname.includes('.gov')) publisher = 'Government domain';
      if (url.hostname.includes('.edu')) publisher = 'Academic domain';
      if (url.hostname.includes('congress.gov')) publisher = 'Congress.gov';
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
    ownershipContext: sourceDomain.includes('.gov')
      ? 'Official government domain'
      : sourceDomain.includes('.edu')
      ? 'Academic domain'
      : sourceDomain
      ? 'Non-government domain'
      : 'No source URL provided',
    originSignals
  };
}

function runVerification(assertionTexts, library) {
  return assertionTexts.map(text => {
    const type = scoreAssertionType(text, library.assertionTypes);
    const flags = buildReviewFlags(type.id, text);

    let notes = '';
    if (type.id === 'normative') {
      notes = 'This is a value-oriented assertion. Treat record systems as framing references, not definitive proof paths.';
    } else if (type.id === 'predictive') {
      notes = 'This is a forecast-style assertion. Model assumptions and prior forecast track records matter.';
    } else if (flags.includes('source_path_incomplete')) {
      notes = 'The statement contains a plausible verification path but does not yet identify a concrete primary record.';
    } else {
      notes = 'The statement points toward an identifiable record system class.';
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

function renderMeaning(meaning) {
  const panel = document.getElementById('meaningPanel');
  const actions = meaning.actions.length
    ? `<div class="card"><div class="small-label">Action signals</div><ul class="list">${meaning.actions.map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul></div>`
    : '';
  const timeline = meaning.timelineSignals.length
    ? `<div class="card"><div class="small-label">Timeline signals</div><ul class="list">${meaning.timelineSignals.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul></div>`
    : '';

  panel.innerHTML = `
    <div class="card">
      <div class="small-label">Plain meaning</div>
      <p>${escapeHtml(meaning.plainMeaning)}</p>
    </div>
    <div class="card">
      <div class="small-label">Detected assertions</div>
      ${
        meaning.assertions.length
          ? `<ul class="list">${meaning.assertions.map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`
          : `<p class="empty">No assertions detected.</p>`
      }
    </div>
    ${actions}
    ${timeline}
  `;
}

function renderOrigin(origin) {
  const panel = document.getElementById('originPanel');
  panel.innerHTML = `
    <div class="grid">
      <div class="card"><div class="small-label">Source domain</div><p>${escapeHtml(origin.sourceDomain || 'None detected')}</p></div>
      <div class="card"><div class="small-label">Publisher</div><p>${escapeHtml(origin.publisher || 'None detected')}</p></div>
      <div class="card"><div class="small-label">Author</div><p>${escapeHtml(origin.author || 'None detected')}</p></div>
      <div class="card"><div class="small-label">Timestamp signal</div><p>${escapeHtml(origin.timestamp || 'None detected')}</p></div>
    </div>
    <div class="card">
      <div class="small-label">Ownership / provenance context</div>
      <p>${escapeHtml(origin.ownershipContext)}</p>
      <div class="small-label" style="margin-top:12px;">Origin signals</div>
      ${
        origin.originSignals.length
          ? `<ul class="list">${origin.originSignals.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`
          : `<p class="empty">No origin signals detected.</p>`
      }
    </div>
  `;
}

function renderVerification(items) {
  const panel = document.getElementById('verificationPanel');
  panel.innerHTML = items.length
    ? items.map(item => `
      <div class="card">
        <div class="small-label">Assertion</div>
        <p>${escapeHtml(item.text)}</p>
        <div class="badge-row">
          <span class="badge type">${escapeHtml(item.typeLabel)}</span>
          ${item.reviewFlags.map(f => `<span class="badge flag">${escapeHtml(f)}</span>`).join('')}
        </div>
        <div class="small-label">Expected record systems</div>
        <ul class="list">${item.recordSystems.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
        <div class="small-label" style="margin-top:12px;">Notes</div>
        <p>${escapeHtml(item.notes)}</p>
      </div>
    `).join('')
    : '<p class="empty">No verification items to display.</p>';
}

function renderDebug(debug) {
  document.getElementById('debugPanel').textContent = JSON.stringify(debug, null, 2);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function analyze() {
  const library = await loadLibrary();
  const input = normalizeInput(
    document.getElementById('inputText').value,
    document.getElementById('sourceUrl').value
  );

  if (!input.rawText) {
    alert('Paste some text first.');
    return;
  }

  const sentences = splitSentences(input.rawText);
  const assertionTexts = detectAssertions(sentences);
  const assertions = assertionTexts.map(text => ({ text }));
  const meaning = extractMeaning(assertions);
  const origin = extractOrigin(input.sourceUrl, input.rawText);
  const verification = runVerification(assertionTexts, library);

  renderMeaning(meaning);
  renderOrigin(origin);
  renderVerification(verification);
  renderDebug({
    sentencesSplit: sentences.length,
    candidateAssertions: assertionTexts.length,
    assertionsReturned: verification.length,
    inputPreview: input.rawText.slice(0, 220)
  });

  document.getElementById('results').classList.remove('hidden');
}

function loadSample() {
  document.getElementById('sourceUrl').value = 'https://www.congress.gov/';
  document.getElementById('inputText').value =
`Section 103 establishes a $108 billion federal bridge repair program beginning in 2026. According to the Department of Transportation, priority funding will go to structurally deficient bridges in interstate corridors. The bill also expands broadband deployment by $50 billion and directs grid modernization funding of $48 billion through the Department of Energy. Analysts say the measure will likely reduce long-term maintenance costs.`;
}

function clearAll() {
  document.getElementById('sourceUrl').value = '';
  document.getElementById('inputText').value = '';
  document.getElementById('results').classList.add('hidden');
  document.getElementById('meaningPanel').innerHTML = '';
  document.getElementById('originPanel').innerHTML = '';
  document.getElementById('verificationPanel').innerHTML = '';
  document.getElementById('debugPanel').textContent = '';
}

document.getElementById('analyzeBtn').addEventListener('click', analyze);
document.getElementById('loadSampleBtn').addEventListener('click', loadSample);
document.getElementById('clearBtn').addEventListener('click', clearAll);
