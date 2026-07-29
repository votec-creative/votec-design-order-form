/* =============================================
   VOTEC デザインオーダーフォーム — form.js
   フォームロジック・バリデーション・ナビゲーション
   ============================================= */

let currentStep = 1;
let maxVisitedStep = 1;
let instructionNotice = '';
const totalSteps = 6;
// テスト中のみ true。false に戻すと通常の必須入力チェックが有効になります。
const TEST_MODE_ALLOW_INCOMPLETE_NAVIGATION = true;
const DRAFT_STORAGE_KEY = 'votec-design-order-form-draft-v1';
const LEGACY_DESIGN_INSTRUCTION_TEMPLATE = '■掲載文言\n\n■デザイン指示\n';
const DESIGN_INSTRUCTION_TEMPLATE = '';

function ensureDesignInstructionTemplate(value) {
  return String(value || '');
}

function stripLegacyDesignInstructionTemplate(value) {
  const text = String(value || '');
  if (text === LEGACY_DESIGN_INSTRUCTION_TEMPLATE) return '';
  if (text.startsWith(LEGACY_DESIGN_INSTRUCTION_TEMPLATE)) {
    return text.slice(LEGACY_DESIGN_INSTRUCTION_TEMPLATE.length).replace(/^\n/, '');
  }
  return text;
}

function hasDesignInstructionContent(value) {
  return String(value || '')
    .replaceAll('■掲載文言', '')
    .replaceAll('■デザイン指示', '')
    .trim().length > 0;
}

function extractDimensions(value) {
  return (String(value || '').match(/\d{2,4}\s*[×xXｘＸ]\s*\d{2,4}/g) || [])
    .map(dimension => dimension.replace(/[xXｘＸ]/g, '×').replace(/\s+/g, ''));
}

function parseBulkInstructions(value) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  const headers = [];
  lines.forEach((line, index) => {
    const imageNumberMatch = line.match(/(\d+)\s*枚目/);
    const dimensions = extractDimensions(line);
    if (imageNumberMatch && dimensions.length) {
      headers.push({
        index,
        heading: line.trim(),
        imageNumber: Number(imageNumberMatch[1]),
        dimensions
      });
    }
  });
  return headers.map((header, index) => ({
    ...header,
    content: lines.slice(header.index + 1, headers[index + 1]?.index ?? lines.length).join('\n').trim()
  }));
}

function formatBulkDesignInstruction(content) {
  const lines = String(content || '').split('\n');
  const copyHeadingIndex = lines.findIndex(line =>
    /^(?:■\s*)?(?:掲載)?文言\s*[：:]?$/.test(line.trim())
  );
  const designLines = copyHeadingIndex >= 0 ? lines.slice(0, copyHeadingIndex) : lines;
  const copyLines = copyHeadingIndex >= 0 ? lines.slice(copyHeadingIndex + 1) : [];
  return `■掲載文言\n${copyLines.join('\n').trim()}\n\n■デザイン指示\n${designLines.join('\n').trim()}\n`;
}

function setBulkInstructionStatus(message, type = '') {
  const status = document.getElementById('bulk-instruction-status');
  if (!status) return;
  status.className = `bulk-instruction-status${type ? ` ${type}` : ''}`;
  status.textContent = message;
}

function resetBulkInstructions() {
  const hasContent = Boolean(
    state.bulkInstruction?.trim() ||
    (Array.isArray(state.bulkAssetFiles) && state.bulkAssetFiles.length)
  );
  if (!hasContent) {
    setBulkInstructionStatus('リセットする内容はありません。', 'is-error');
    return;
  }
  if (!window.confirm('まとめて入力の文章と共通の参考資料・素材をすべてリセットしますか？\n画像ごとの入力欄に反映済みの内容は残ります。')) return;

  (state.bulkAssetFiles || []).forEach(file => {
    const previewUrl = filePreviewUrls.get(file);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      filePreviewUrls.delete(file);
    }
  });
  state.bulkInstruction = '';
  state.bulkAssetFiles = [];

  const input = document.getElementById('bulk-instruction-input');
  if (input) input.value = '';
  const fileInput = document.getElementById('bulk-asset-files');
  if (fileInput) fileInput.value = '';
  const errorEl = document.getElementById('bulk-asset-error');
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.style.display = 'none';
  }
  renderBulkAssetFiles();
  saveDraft();
  setBulkInstructionStatus('まとめて入力をリセットしました。', 'is-success');
}

function applyBulkInstructions({ automatic = false } = {}) {
  const input = document.getElementById('bulk-instruction-input');
  const sourceText = input?.value || state.bulkInstruction || '';
  state.bulkInstruction = sourceText;
  if (!sourceText.trim()) {
    setBulkInstructionStatus('制作内容を入力してください。', 'is-error');
    return false;
  }
  saveDraft();
  setBulkInstructionStatus('まとめて入力の内容を保存しました。', 'is-success');
  return true;

  /*
   * 旧仕様の画像別自動振り分け処理は、保存枚数と依頼文内の枚数が一致しない
   * ケースがあるため使用しません。まとめて入力は原文のまま保持します。
   */
  const blocks = parseBulkInstructions(sourceText);
  if (!blocks.length) {
    setBulkInstructionStatus('サイズと「○枚目」を含む見出しを読み取れませんでした。入力例をご確認ください。', 'is-error');
    return false;
  }

  const targets = getInstructionTargets();
  if (!targets.length) {
    setBulkInstructionStatus('先にステップ3で媒体・サイズ・枚数を選択してください。', 'is-error');
    return false;
  }

  targets.forEach(target => {
    const targetDimensions = extractDimensions(`${target.sizeLabel} ${target.displayName}`);
    const requiredQuantity = blocks.reduce((maximum, block) => (
      block.dimensions.some(dimension => targetDimensions.includes(dimension))
        ? Math.max(maximum, block.imageNumber)
        : maximum
    ), target.quantity);
    if (requiredQuantity <= target.quantity) return;

    const mediaEntry = state.mediaState[target.mediumName];
    ensureMediaEntryQuantities(mediaEntry);
    if (target.sourceType === 'suggestion') {
      mediaEntry.sizeQuantities[target.sourceKey] = requiredQuantity;
    } else if (target.sourceType === 'custom') {
      mediaEntry.customSizeQuantities[target.sourceIndex] = requiredQuantity;
    }
    target.quantity = requiredQuantity;
  });

  syncInstructionGroups();
  const hasConflicts = blocks.some(block => targets.some(target => {
    const targetDimensions = extractDimensions(`${target.sizeLabel} ${target.displayName}`);
    const matchesTarget = block.dimensions.some(dimension => targetDimensions.includes(dimension)) &&
      block.imageNumber >= 1 &&
      block.imageNumber <= target.quantity;
    if (!matchesTarget) return false;
    const card = state.imgCards.find(item =>
      item.targetIds?.[0] === target.id &&
      (Number(item.imageNumber) || 1) === block.imageNumber
    );
    return card &&
      hasDesignInstructionContent(card.designTxt) &&
      card.designTxt !== formatBulkDesignInstruction(block.content);
  }));
  if (automatic && hasConflicts &&
      !window.confirm('画像ごとに入力済みの指示があります。まとめて入力の内容で上書きしますか？')) {
    setBulkInstructionStatus('上書きを取り消しました。個別入力を確認してから、もう一度「次へ」を押してください。', 'is-error');
    return false;
  }
  const overwrite = true;
  const appliedCardKeys = new Set();
  const skippedHeadings = [];

  blocks.forEach(block => {
    const matchingTargets = targets.filter(target => {
      const targetDimensions = extractDimensions(`${target.sizeLabel} ${target.displayName}`);
      return block.dimensions.some(dimension => targetDimensions.includes(dimension)) &&
        block.imageNumber >= 1 &&
        block.imageNumber <= target.quantity;
    });

    if (!matchingTargets.length) {
      skippedHeadings.push(block.heading);
      return;
    }

    matchingTargets.forEach(target => {
      let card = state.imgCards.find(item =>
        item.targetIds?.[0] === target.id &&
        (Number(item.imageNumber) || 1) === block.imageNumber
      );
      if (!card) {
        card = {
          ...makeBlankCard(),
          targetIds: [target.id],
          imageNumber: block.imageNumber
        };
        state.imgCards.push(card);
      }
      const sharedFiles = Array.isArray(state.bulkAssetFiles) ? state.bulkAssetFiles : [];
      sharedFiles.forEach(file => {
        if (!card.assetFiles.some(existingFile =>
          existingFile.name === file.name && existingFile.size === file.size
        )) {
          card.assetFiles.push(file);
          appliedCardKeys.add(getInstructionCardKey(card));
        }
      });
      if (!overwrite && hasDesignInstructionContent(card.designTxt)) {
        skippedHeadings.push(`${block.heading}（入力済み）`);
        return;
      }
      card.designTxt = formatBulkDesignInstruction(block.content);
      appliedCardKeys.add(getInstructionCardKey(card));
    });
  });

  if (appliedCardKeys.size) {
    const firstAppliedIndex = state.imgCards.findIndex(card => appliedCardKeys.has(getInstructionCardKey(card)));
    if (firstAppliedIndex >= 0) state.activeInstructionGroup = firstAppliedIndex;
    renderInstructionGroups();
    saveDraft();
  }

  const skippedSummary = skippedHeadings.length
    ? ` 未反映：${[...new Set(skippedHeadings)].join('、')}`
    : '';
  setBulkInstructionStatus(
    `${appliedCardKeys.size}件の制作画像へ反映しました。${skippedSummary}`,
    appliedCardKeys.size ? 'is-success' : 'is-error'
  );
  return appliedCardKeys.size > 0;
}

const COLOR_OPTIONS = ['金色（ゴールド）','銀色（シルバー）','白','黒','灰色（グレー）','赤','オレンジ','黄色','緑','青','紫','ピンク','茶色','ベージュ'];
const COLOR_PRESET_CODES = {
  '金色（ゴールド）': '#D4AF37',
  '銀色（シルバー）': '#C0C0C0',
  '白': '#FFFFFF',
  '黒': '#111111',
  '灰色（グレー）': '#808080',
  '赤': '#E53935',
  'オレンジ': '#FB8C00',
  '黄色': '#FDD835',
  '緑': '#43A047',
  '青': '#1E88E5',
  '紫': '#8E24AA',
  'ピンク': '#EC407A',
  '茶色': '#795548',
  'ベージュ': '#B08D6A'
};
const COLOR_NAME_ALIASES = {
  'ゴールド': '金色（ゴールド）', '金色': '金色（ゴールド）',
  'シルバー': '銀色（シルバー）', '銀色': '銀色（シルバー）',
  'ホワイト': '白', 'ブラック': '黒', 'グレー': '灰色（グレー）', '灰色': '灰色（グレー）',
  'レッド': '赤', 'イエロー': '黄色', 'グリーン': '緑', 'ブルー': '青', 'パープル': '紫',
  'ブラウン・ベージュ': 'ベージュ', 'マルチカラー': ''
};
const normalizeColorName = color => COLOR_NAME_ALIASES[color] ?? (COLOR_OPTIONS.includes(color) ? color : '');
const moodGroups = [
  {
    key: 'atmosphere',
    label: '雰囲気',
    hint: '近いものを1〜2個選んでください。選ばない場合は原稿内容に合わせて制作します。',
    maxSelections: 2,
    sections: [
      { label: '上品・落ち着き', options: ['高級・上質', 'ゴージャス', 'エレガント', '清楚', 'モード', '大人っぽい'] },
      { label: '親しみ・やわらかさ', options: ['かわいい', 'ガーリー', 'ゆめかわ', 'ポップ', 'ナチュラル', '癒し・やさしい', '爽やか・ヘルシー', '韓国風'] },
      { label: '強さ・色気', options: ['クール', 'スタイリッシュ', 'ダーク', 'ミステリアス', 'セクシー・色っぽい', 'インパクト重視'] }
    ]
  },
  {
    key: 'worldview',
    label: '世界観・モチーフ',
    hint: '複数選択可・任意',
    collapsible: true,
    openKey: 'worldviewOpen',
    sections: [
      { label: '色・光', options: ['ネオン（蛍光色・発光）', '夜・ナイトシーン（夜景・暗がり）', '光・キラキラ', '星空・宇宙', 'グラデーション', 'モノトーン'] },
      { label: '表現スタイル', options: ['写真中心', 'イラスト', '手書き風', '雑誌・エディトリアル風', 'SNS風', '漫画・吹き出し', '3D・立体', 'パチンコ風'] },
      { label: '時代・質感', options: ['レトロ・昭和', 'Y2K・平成レトロ', 'ヴィンテージ', '未来的・サイバー'] },
      { label: '素材・装飾', options: ['ゴールド・金箔', '大理石', 'ジュエリー・宝石', '花・ボタニカル', '水・透明感', 'リボン・レース', '和柄・和風'] }
    ]
  }
];
const ATMOSPHERE_OPTIONS = moodGroups[0].sections.flatMap(section => section.options);
const WORLDVIEW_OPTIONS = moodGroups[1].sections.flatMap(section => section.options);
const VALID_MOOD_OPTIONS = moodGroups.flatMap(group => group.sections
  ? group.sections.flatMap(section => section.options)
  : group.options);
const INFO_DENSITY_OPTIONS = [
  { label: 'シンプル', description: '余白多め・要素少なく' },
  { label: '標準', description: 'バランス重視' },
  { label: '情報量多め', description: '訴求を詰めて掲載' }
];
const MAX_REFERENCE_FILE_SIZE = 20 * 1024 * 1024;
const IMAGE_FILE_EXTENSIONS = [
  'png', 'apng', 'jpg', 'jpeg', 'jpe', 'jfif', 'webp', 'gif', 'bmp',
  'tif', 'tiff', 'heic', 'heif', 'avif', 'svg', 'ico', 'jxl',
  'raw', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'raf'
];
const ARCHIVE_FILE_EXTENSIONS = [
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'lzh', 'cab'
];
const PERSON_FILE_EXTENSIONS = [...IMAGE_FILE_EXTENSIONS, ...ARCHIVE_FILE_EXTENSIONS];
const REFERENCE_FILE_EXTENSIONS = [
  ...PERSON_FILE_EXTENSIONS,
  'pdf', 'txt', 'rtf', 'md', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'log',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp', 'pages', 'numbers', 'key',
  'psd', 'psb', 'ai', 'eps', 'indd', 'xd', 'fig', 'sketch',
  'afdesign', 'afphoto', 'cdr',
  'mp4', 'mov', 'm4v', 'avi', 'wmv', 'mkv', 'webm',
  'mp3', 'wav', 'm4a', 'aac'
];
const PERSON_FILE_ACCEPT = PERSON_FILE_EXTENSIONS.map(extension => `.${extension}`).join(',');
const REFERENCE_FILE_ACCEPT = REFERENCE_FILE_EXTENSIONS.map(extension => `.${extension}`).join(',');
const PREVIEWABLE_IMAGE_EXTENSIONS = [
  'png', 'apng', 'jpg', 'jpeg', 'jpe', 'jfif', 'webp', 'gif', 'bmp', 'avif', 'svg'
];
const filePreviewUrls = new WeakMap();

/* Step2: 画像種別（rc-new等のIDサフィックス） */
const IMG_TYPE_CARD_KEYS = ['new', 'fix', 'pay'];

/* Step5: 納期希望の値とラジオボタンIDの対応表 */
const DELIVERY_BUTTON_ID_BY_VALUE = { '希望なし': 'd1', '事前予約': 'd2', '納期指定': 'd3' };

/* ステップインジケーターのアイコンクラス（インデックス1〜6） */
const STEP_ICON_CLASSES = ['', 'ti-user', 'ti-photo', 'ti-layout', 'ti-brush', 'ti-clock', 'ti-check'];

let state = {
  office: '', officeId: 0,
  staff: '', client: '本人', agent: '', email: '',
  imgType: 0, imcUrl: '',
  pay: 'ポイント', payUrl: '',
  shop: '', area: '', shopUrl: '', shopUrl2: '', urlMode: 'あり', urlMode2: 'あり',
  industry: '', industryOther: '',
  selectedMedia: [],       // ['バニラ', '駅ちか', ...]
  openMedia: [],
  mediumOther: '',
  mediaState: {},          // { 'バニラ': { selectedSizes, customSizes, sizeQuantities, customSizeQuantities } }
  imgsize: '', count: 0,
  imgMode: 'images',
  activeInstructionGroup: 0,
  bulkInstruction: '',
  bulkAssetFiles: [],
  common: null,            // 共通指示（カードと同じ形のオブジェクト）
  imgCards: [],            // 制作画像ごとの指示カード
  delivery: '', deliveryDate: '',
  des1: '', des2: '', des3: '',
  files: []
};

function makeBlankCard() {
  return {
    targetImage: '',
    personUsage: '', person: '', staffPhotoAllowed: false, personFreeNote: '', personFiles: [],
    design: '', designTxt: DESIGN_INSTRUCTION_TEMPLATE,
    refNote: '', refFiles: [],
    assetNote: '', assetFiles: [],
    baseColor: '', mainColor: '', accentColor: '',
    baseColorCode: '', mainColorCode: '', accentColorCode: '', colorNote: '',
    moods: [], infoDensity: '', atmosphereOther: '', worldviewOther: '',
    worldviewOpen: false,
    targetIds: [],
    imageNumber: 1,
    sameAsCardKey: '',
    advancedOpen: false,
    collapsed: false
  };
}
state.common = makeBlankCard();

/* ========== お知らせ・混雑状況 ========== */
/* 混雑状況はサンプル値。実運用では稼働状況データに接続する想定 */
function initCongestion() {
  const congestionLevel = 'normal'; // 'active' | 'normal' | 'busy'
  const iconEl = document.getElementById('congestion-icon');
  const labelEl = document.getElementById('congestion-label');
  const subEl = document.getElementById('congestion-sub');
  iconEl.className = `congestion-icon ${congestionLevel}`;
  if (congestionLevel === 'busy') {
    iconEl.innerHTML = '<i class="ti ti-alert-triangle"></i>';
    labelEl.textContent = '混雑中';
    subEl.innerHTML = '現在、ご依頼が集中しています。<br>納期短縮はご希望に沿えない場合があります。';
  } else if (congestionLevel === 'active') {
    iconEl.innerHTML = '<i class="ti ti-bolt"></i>';
    labelEl.textContent = '積極対応中';
    subEl.innerHTML = '比較的早めに対応できる状況です。<br>追加のご依頼も歓迎しています。';
  } else {
    iconEl.innerHTML = '<i class="ti ti-clock"></i>';
    labelEl.textContent = '通常稼働';
    subEl.textContent = '標準的な対応状況です。';
  }
}

function initNotices() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const noticeBody = document.getElementById('notice-body');
  if (!noticeBody) return;
  noticeBody.querySelectorAll('.info-entry[data-end-date]').forEach(entry => {
    const endDate = new Date(entry.dataset.endDate + 'T23:59:59');
    if (endDate < today) entry.remove();
  });
  if (!noticeBody.querySelector('.info-entry')) {
    noticeBody.innerHTML = '<div class="info-entry"><div class="info-entry-text">現在、お知らせはありません。</div></div>';
  }
}

/* ========== STEP 1 ========== */
function onOffice() {
  const officeSelect = document.getElementById('sel-office');
  const selectedOption = officeSelect.options[officeSelect.selectedIndex];
  state.office = officeSelect.value;
  state.officeId = parseInt(selectedOption.getAttribute('data-id') || 0) || 0;

  const staffSelect = document.getElementById('sel-staff');
  const staffOtherInput = document.getElementById('inp-staff-other');

  if (officeSelect.value === 'VOTEC' || officeSelect.value === 'その他') {
    staffSelect.style.display = 'none';
    staffOtherInput.style.display = 'block';
    staffSelect.innerHTML = '<option value="">-</option>';
  } else {
    staffSelect.style.display = 'block';
    staffOtherInput.style.display = 'none';
    const staffList = staffData[state.officeId] || [];
    staffSelect.innerHTML = '<option value="">選択してください</option>' +
      staffList.map(name => `<option>${name}</option>`).join('');
  }

  const existingNote = document.getElementById('kansai-note');
  if (existingNote) existingNote.remove();
  if (officeSelect.value === '関西支社') {
    const noteEl = document.createElement('div');
    noteEl.id = 'kansai-note';
    noteEl.className = 'warn-box';
    noteEl.style.marginTop = '8px';
    noteEl.innerHTML = '<i class="ti ti-alert-triangle"></i>ご依頼前に太田さんへの確認が必要です';
    document.getElementById('f-office').appendChild(noteEl);
  }
  document.getElementById('f-office').classList.remove('inv');
}

function setClient(value) {
  state.client = value;
  document.getElementById('rb-honin').classList.toggle('sel', value === '本人');
  document.getElementById('rb-dairi').classList.toggle('sel', value === '代理');
  document.getElementById('f-agent').style.display = value === '代理' ? 'block' : 'none';
}

/* ========== STEP 2 ========== */
function setImgType(id) {
  state.imgType = id;
  document.getElementById('f-imgtype').classList.add('has-selection');
  document.getElementById('imgtype-followup').classList.toggle('show', id === 3);
  IMG_TYPE_CARD_KEYS.forEach((key, index) =>
    document.getElementById('rc-' + key).classList.toggle('sel', index + 1 === id)
  );
  setPay(id === 3 ? '有料' : 'ポイント');
  document.getElementById('f-imgtype').classList.remove('inv');
}

function setPay(value) {
  state.pay = value;
  document.getElementById('f-pay-url').style.display = value === '有料' ? 'block' : 'none';
  if (value !== '有料') document.getElementById('f-pay-url').classList.remove('inv');
}

function setUrlMode(target, hasNoUrl) {
  const suffix = target === 2 ? '2' : '';
  state[target === 2 ? 'urlMode2' : 'urlMode'] = hasNoUrl ? 'なし' : 'あり';
  document.getElementById('chk-urlnone' + suffix).checked = hasNoUrl;
  document.getElementById('inp-shopurl' + suffix).disabled = hasNoUrl;
  if (target === 1) document.getElementById('f-shopurl').classList.remove('inv');
}

/* ========== STEP 3: 業種・媒体・サイズ（複数媒体対応） ========== */
function setIndustry(name, el) {
  state.industry = name;
  state.industryOther = '';
  document.querySelectorAll('#industry-btns .rbtn').forEach(btn => btn.classList.remove('sel'));
  el.classList.add('sel');
  document.querySelectorAll('.fuzoku-warn').forEach(warning => {
    warning.style.display = name === '風俗' ? 'flex' : 'none';
  });
  const industryOtherWrap = document.getElementById('f-industry-other');
  const industryOtherInput = document.getElementById('inp-industry-other');
  industryOtherWrap.style.display = name === 'その他' ? 'block' : 'none';
  industryOtherWrap.classList.remove('inv');
  industryOtherInput.value = '';

  state.selectedMedia = [];
  state.openMedia = [];
  state.mediumOther = '';
  state.mediaState = {};
  renderMediumChips(name);
  document.getElementById('inp-medium-other').value = '';
  document.getElementById('medium-blocks').innerHTML = '';
  document.getElementById('f-medium-other').style.display = 'none';
  document.getElementById('f-industry').classList.remove('inv');
  if (name === 'その他') {
    toggleMedium('その他');
    requestAnimationFrame(() => industryOtherInput.focus());
  } else {
    autoFillImgSize();
  }
}

function renderMediumChips(industry) {
  const mediumList = mediaByIndustry[industry] || [];
  const chipsWrap = document.getElementById('medium-chips');
  if (!mediumList.length) {
    chipsWrap.innerHTML = '<div style="font-size:13px;color:var(--color-text-muted)">先に業種を選択してください</div>';
    return;
  }
  chipsWrap.innerHTML = mediumList.map(mediumName => {
    const isSelected = state.selectedMedia.includes(mediumName);
    return `
      <label class="medium-select-row ${isSelected ? 'is-selected' : ''}" for="mchip-${cssId(mediumName)}">
        <input type="checkbox" id="mchip-${cssId(mediumName)}" ${isSelected ? 'checked' : ''} onchange="toggleMedium('${escJs(mediumName)}')">
        <strong>${escHtml(mediumName)}</strong>
      </label>`;
  }).join('');
}

function cssId(s) { return s.replace(/[^a-zA-Z0-9]/g, c => c.charCodeAt(0)); }
function escJs(s) { return (s || '').replace(/'/g, "\\'"); }

function toggleMedium(mediumName) {
  const existingIndex = state.selectedMedia.indexOf(mediumName);
  if (existingIndex === -1) {
    state.selectedMedia.push(mediumName);
    if (!state.openMedia.includes(mediumName)) state.openMedia.push(mediumName);
    if (!state.mediaState[mediumName]) {
      state.mediaState[mediumName] = {
        selectedSizes: [],
        customSizes: [''],
        sizeQuantities: {},
        customSizeQuantities: [1]
      };
    }
  } else {
    state.selectedMedia.splice(existingIndex, 1);
    delete state.mediaState[mediumName];
    state.openMedia = state.openMedia.filter(item => item !== mediumName);
  }
  document.getElementById('f-medium-other').style.display = state.selectedMedia.includes('その他') ? 'block' : 'none';
  document.getElementById('f-medium').classList.remove('inv');
  renderMediumChips(state.industry);
  renderMediumBlocks();
  autoFillImgSize();
}

function toggleMediumAccordion(mediumName) {
  if (!state.selectedMedia.includes(mediumName)) {
    toggleMedium(mediumName);
    return;
  }
  if (state.openMedia.includes(mediumName)) {
    state.openMedia = state.openMedia.filter(item => item !== mediumName);
  } else {
    state.openMedia.push(mediumName);
  }
  renderMediumBlocks();
}

function renderMediumBlocks() {
  const wrap = document.getElementById('medium-blocks');
  if (!wrap) return;
  if (!state.selectedMedia.length) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = `
    <div class="medium-settings-heading">
      <strong>サイズ入力</strong>
      <span>選択した媒体ごとに設定してください</span>
    </div>
  ` + state.selectedMedia.map(mediumName => {
    const isOpen = state.openMedia.includes(mediumName);
    const mediaEntry = state.mediaState[mediumName];
    ensureMediaEntryQuantities(mediaEntry);
    const suggestions = getSizeSuggestions(mediumName);
    const heading = mediumName === 'その他' ? 'その他媒体' : mediumName;
    const selectedEntries = getSelectedSizeEntriesForMedium(mediumName);
    const mediumTotal = selectedEntries.reduce((total, entry) => total + entry.quantity, 0);
    const settingSummary = selectedEntries.length
      ? `${selectedEntries.length}サイズ・${mediumTotal}枚`
      : 'サイズ未設定';
    return `
    <section class="medium-accordion is-selected ${isOpen ? 'is-open' : ''}" id="mb-${cssId(mediumName)}">
      <div class="medium-accordion-head">
        <strong class="medium-accordion-title">${escHtml(heading)}</strong>
        <button type="button" class="medium-accordion-toggle" aria-expanded="${isOpen}" aria-label="${isOpen ? `${heading}のサイズ入力を閉じる` : `${heading}のサイズ入力を開く`}" onclick="toggleMediumAccordion('${escJs(mediumName)}')">
          <span class="medium-accordion-status ${selectedEntries.length ? 'is-set' : 'is-empty'}">${settingSummary}</span>
          <span class="medium-accordion-symbol" aria-hidden="true">${isOpen ? '−' : '＋'}</span>
        </button>
      </div>
      <div class="medium-accordion-body" ${isOpen ? '' : 'hidden'}>
        <div class="field medium-size-field" id="f-size-${cssId(mediumName)}">
        <div class="lbl">サイズを入力 <span class="req">必須</span></div>
        <div class="hint">画像名を含めても構いません。例：メイン 700×300</div>
        <div class="size-input-list">
          ${mediaEntry.customSizes.map((sizeValue, sizeIndex) => `
            <div class="size-input-row">
              <input type="text" class="control-w-md" id="custom-size-${cssId(mediumName)}-${sizeIndex}" placeholder="例：700×300" value="${escAttr(sizeValue)}" oninput="updateCustomSize('${escJs(mediumName)}',${sizeIndex},this.value)">
              ${renderQuantityStepper(
                mediaEntry.customSizeQuantities[sizeIndex],
                `adjustSizeQuantity('${escJs(mediumName)}','custom',${sizeIndex},-1)`,
                `adjustSizeQuantity('${escJs(mediumName)}','custom',${sizeIndex},1)`,
                `${heading}の入力サイズ`
              )}
              ${mediaEntry.customSizes.length > 1 ? `<button type="button" class="size-remove-btn" onclick="removeCustomSize('${escJs(mediumName)}',${sizeIndex})"><i class="ti ti-x"></i>削除</button>` : ''}
            </div>`).join('')}
        </div>
        <button type="button" class="size-add-btn" onclick="addCustomSize('${escJs(mediumName)}')"><i class="ti ti-plus"></i>サイズを追加</button>
        ${suggestions.length ? `
          <details class="size-suggestion-details" ${mediaEntry.selectedSizes.length ? 'open' : ''}>
            <summary>よく使うサイズ候補から選ぶ <span>${suggestions.length}件</span></summary>
            <div class="size-section">
              <div class="size-grid">
                ${suggestions.map(sizeLabel =>
                  renderSizeSuggestion(
                    mediumName,
                    sizeLabel,
                    mediaEntry.selectedSizes.includes(sizeLabel),
                    mediaEntry.sizeQuantities[sizeLabel] || 1
                  )
                ).join('')}
              </div>
            </div>
          </details>` : `<div class="size-catalog-note">登録済みのサイズ候補はありません。上の入力欄へ直接入力してください。</div>`}
        <div class="err">サイズを入力するか、候補から選択してください</div>
        </div>
      </div>
    </section>`;
  }).join('');
}

function ensureMediaEntryQuantities(mediaEntry) {
  if (!mediaEntry.sizeQuantities) mediaEntry.sizeQuantities = {};
  if (!mediaEntry.customSizeQuantities) mediaEntry.customSizeQuantities = [];
  while (mediaEntry.customSizeQuantities.length < mediaEntry.customSizes.length) {
    mediaEntry.customSizeQuantities.push(1);
  }
}

function renderQuantityStepper(quantity, decreaseAction, increaseAction, contextLabel) {
  return `
    <div class="size-quantity-stepper" aria-label="${escAttr(contextLabel)}の枚数">
      <button type="button" aria-label="枚数を1枚減らす" onclick="${decreaseAction}" ${quantity <= 1 ? 'disabled' : ''}>−</button>
      <strong>${quantity}枚</strong>
      <button type="button" aria-label="枚数を1枚増やす" onclick="${increaseAction}">＋</button>
    </div>`;
}

function getSizeSuggestions(mediumName) {
  const sizeGroups = [];
  (planSizeData[mediumName] || []).forEach(plan => {
    const sizes = (plan.sizes || []).filter(sizeLabel => /\d/.test(sizeLabel) && /[×xX]/.test(sizeLabel));
    sizes.forEach(sizeLabel => {
      const keepSeparate = mediumName === '駅ちか' && plan.plan === '駅DX';
      const displayPlanName = normalizePlanNameForDisplay(mediumName, plan.plan);
      const displaySizeLabel = normalizeSizeLabelForDisplay(mediumName, sizeLabel);
      const groupKey = keepSeparate ? `${displayPlanName}:${displaySizeLabel}` : displaySizeLabel;
      const existingGroup = sizeGroups.find(group => group.key === groupKey);
      if (existingGroup) {
        existingGroup.planNames.push(displayPlanName);
      } else {
        sizeGroups.push({ key: groupKey, planNames: [displayPlanName], sizeLabel: displaySizeLabel });
      }
    });
  });
  return sizeGroups
    .map(group => formatPlanSizeLabel(formatCombinedPlanName(group.planNames), group.sizeLabel))
    .sort((left, right) => getSizeSuggestionPriority(left) - getSizeSuggestionPriority(right));
}

function normalizePlanNameForDisplay(mediumName, planName) {
  return mediumName === '爆サイ.com' ? planName.replace(/^【\d+】/, '') : planName;
}

function normalizeSizeLabelForDisplay(mediumName, sizeLabel) {
  return mediumName === '爆サイ.com' ? sizeLabel.replace(/^【\d+】/, '') : sizeLabel;
}

function formatCombinedPlanName(planNames) {
  if (planNames.length > 1 && planNames.every(planName => planName.endsWith('プラン'))) {
    return `${planNames.map(planName => planName.slice(0, -3)).join('・')}プラン`;
  }
  const alphaPlans = planNames.map(planName => planName.match(/^(.*?)([A-Z])$/));
  if (planNames.length > 1 && alphaPlans.every(Boolean) && alphaPlans.every(match => match[1] === alphaPlans[0][1])) {
    const prefix = alphaPlans[0][1];
    const letters = alphaPlans.map(match => match[2]);
    const isContinuousRange = letters.length >= 3 &&
      letters.every((letter, index) => letter.charCodeAt(0) === letters[0].charCodeAt(0) + index);
    return isContinuousRange ? `${prefix}${letters[0]}～${letters[letters.length - 1]}` : `${prefix}${letters.join('・')}`;
  }
  return planNames.join('・');
}

function getSizeSuggestionPriority(sizeLabel) {
  return sizeLabel.includes('メイン') ? 0 : 1;
}

function formatPlanSizeLabel(planName, sizeLabel) {
  return planName ? `【${planName}】${sizeLabel}` : sizeLabel;
}

function splitSizeSuggestion(sizeLabel) {
  const tags = [];
  let remainder = sizeLabel.trim();
  let tagMatch = remainder.match(/^【([^】]+)】\s*/);
  while (tagMatch) {
    tags.push(tagMatch[1]);
    remainder = remainder.slice(tagMatch[0].length);
    tagMatch = remainder.match(/^【([^】]+)】\s*/);
  }
  const noteMatch = remainder.match(/^(.+?)([（(].*)$/);
  return {
    plan: tags[0] || '',
    title: tags.slice(1).join(' / '),
    dimension: noteMatch ? noteMatch[1].trim() : remainder,
    note: noteMatch ? noteMatch[2].trim() : ''
  };
}

function getSizeSuggestionPlanName(mediumName, sizeLabel) {
  const planMatch = sizeLabel.match(/^【([^】]+)】/);
  return planMatch ? planMatch[1] : '';
}

function renderSizeSuggestion(mediumName, sizeLabel, isSelected, quantity) {
  const suggestion = splitSizeSuggestion(sizeLabel);
  const checkboxId = `size-choice-${cssId(mediumName)}-${cssId(sizeLabel)}`;
  return `
    <div class="size-item size-option-card ${isSelected ? 'chk' : ''}" data-medium="${escAttr(mediumName)}" title="${escAttr(sizeLabel)}">
      <input type="checkbox" id="${checkboxId}" ${isSelected ? 'checked' : ''} onchange="toggleSizeSuggestion('${escJs(mediumName)}','${escJs(sizeLabel)}',this)">
      <label class="size-option-content" for="${checkboxId}">
        ${suggestion.title ? `<span class="size-option-title">${escHtml(suggestion.title)}</span>` : ''}
        <strong class="size-option-dimension">${escHtml(suggestion.dimension)}</strong>
        ${suggestion.plan ? `<span class="size-option-plan">${escHtml(suggestion.plan)}</span>` : ''}
        ${suggestion.note ? `<span class="size-option-note">${escHtml(suggestion.note)}</span>` : ''}
      </label>
      ${isSelected ? renderQuantityStepper(
        quantity,
        `adjustSizeQuantity('${escJs(mediumName)}','suggestion','${escJs(sizeLabel)}',-1)`,
        `adjustSizeQuantity('${escJs(mediumName)}','suggestion','${escJs(sizeLabel)}',1)`,
        `${sizeLabel}`
      ) : ''}
    </div>`;
}

function toggleSizeSuggestion(mediumName, sizeLabel, checkbox) {
  const mediaEntry = state.mediaState[mediumName];
  ensureMediaEntryQuantities(mediaEntry);
  if (checkbox.checked) {
    if (!mediaEntry.selectedSizes.includes(sizeLabel)) mediaEntry.selectedSizes.push(sizeLabel);
    if (!mediaEntry.sizeQuantities[sizeLabel]) mediaEntry.sizeQuantities[sizeLabel] = 1;
  } else {
    mediaEntry.selectedSizes = mediaEntry.selectedSizes.filter(item => item !== sizeLabel);
    delete mediaEntry.sizeQuantities[sizeLabel];
  }
  if (hasMediumSize(mediumName)) document.getElementById('f-size-' + cssId(mediumName)).classList.remove('inv');
  renderMediumBlocks();
  autoFillImgSize();
}

function adjustSizeQuantity(mediumName, source, key, delta) {
  const mediaEntry = state.mediaState[mediumName];
  ensureMediaEntryQuantities(mediaEntry);
  if (source === 'suggestion') {
    mediaEntry.sizeQuantities[key] = Math.max(1, (mediaEntry.sizeQuantities[key] || 1) + delta);
  } else {
    const sizeIndex = Number(key);
    mediaEntry.customSizeQuantities[sizeIndex] = Math.max(
      1,
      (mediaEntry.customSizeQuantities[sizeIndex] || 1) + delta
    );
  }
  renderMediumBlocks();
  autoFillImgSize();
}

function updateCustomSize(mediumName, sizeIndex, value) {
  state.mediaState[mediumName].customSizes[sizeIndex] = value;
  if (hasMediumSize(mediumName)) document.getElementById('f-size-' + cssId(mediumName)).classList.remove('inv');
  autoFillImgSize();
  updateMediumAccordionSummary(mediumName);
}

function updateMediumAccordionSummary(mediumName) {
  const block = document.getElementById('mb-' + cssId(mediumName));
  if (!block) return;
  const summary = block.querySelector('.medium-accordion-toggle span');
  if (!summary) return;
  const entries = getSelectedSizeEntriesForMedium(mediumName);
  const total = entries.reduce((sum, entry) => sum + entry.quantity, 0);
  summary.textContent = entries.length ? `${entries.length}サイズ・${total}枚` : 'サイズ未設定';
  summary.classList.toggle('is-empty', !entries.length);
  summary.classList.toggle('is-set', !!entries.length);
}

function addCustomSize(mediumName) {
  const mediaEntry = state.mediaState[mediumName];
  ensureMediaEntryQuantities(mediaEntry);
  mediaEntry.customSizes.push('');
  mediaEntry.customSizeQuantities.push(1);
  renderMediumBlocks();
  const newInput = document.getElementById(`custom-size-${cssId(mediumName)}-${mediaEntry.customSizes.length - 1}`);
  if (newInput) newInput.focus();
}

function removeCustomSize(mediumName, sizeIndex) {
  const mediaEntry = state.mediaState[mediumName];
  ensureMediaEntryQuantities(mediaEntry);
  mediaEntry.customSizes.splice(sizeIndex, 1);
  mediaEntry.customSizeQuantities.splice(sizeIndex, 1);
  if (!mediaEntry.customSizes.length) {
    mediaEntry.customSizes.push('');
    mediaEntry.customSizeQuantities.push(1);
  }
  renderMediumBlocks();
  autoFillImgSize();
}

function hasMediumSize(mediumName) {
  const mediaEntry = state.mediaState[mediumName];
  return !!(mediaEntry && (
    mediaEntry.selectedSizes.length ||
    mediaEntry.customSizes.some(sizeValue => sizeValue.trim())
  ));
}

function getMediumDisplayName(mediumName) {
  if (mediumName !== 'その他') return mediumName;
  const otherInput = document.getElementById('inp-medium-other');
  return (otherInput && otherInput.value.trim()) || 'その他媒体';
}

function allSelectedSizesFlat() {
  const flatSizes = [];
  state.selectedMedia.forEach(mediumName => {
    const displayName = getMediumDisplayName(mediumName);
    getSelectedSizeEntriesForMedium(mediumName).forEach(entry => {
      flatSizes.push(`【${displayName}】${formatSizeWithQuantity(entry)}`);
    });
  });
  return flatSizes;
}

function getSelectedSizeEntriesForMedium(mediumName) {
  const mediaEntry = state.mediaState[mediumName];
  if (!mediaEntry) return [];
  ensureMediaEntryQuantities(mediaEntry);
  return [
    ...mediaEntry.selectedSizes.map(sizeLabel => ({
      label: sizeLabel,
      quantity: mediaEntry.sizeQuantities[sizeLabel] || 1,
      sourceType: 'suggestion',
      sourceKey: sizeLabel
    })),
    ...mediaEntry.customSizes
      .map((sizeValue, sizeIndex) => ({
        label: sizeValue.trim(),
        quantity: mediaEntry.customSizeQuantities[sizeIndex] || 1,
        sourceType: 'custom',
        sourceIndex: sizeIndex
      }))
      .filter(entry => entry.label)
  ];
}

function formatSizeWithQuantity(entry) {
  return `${entry.label} × ${entry.quantity}枚`;
}

function getTotalImageCount() {
  return state.selectedMedia.reduce((total, mediumName) => (
    total + getSelectedSizeEntriesForMedium(mediumName)
      .reduce((mediumTotal, entry) => mediumTotal + entry.quantity, 0)
  ), 0);
}

function renderFloatingMediaSummary(visibleStep = currentStep) {
  const panel = document.getElementById('floating-media-summary');
  if (!panel) return;
  const menuToggle = document.getElementById('mobile-summary-menu-toggle');
  const menuCount = document.getElementById('mobile-summary-menu-count');
  const siteHeader = document.querySelector('.site-header');

  const instructionTargets = getInstructionTargets();
  const entries = state.selectedMedia.map(mediumName => ({
    name: getMediumDisplayName(mediumName),
    sizes: instructionTargets.filter(target => target.mediumName === mediumName)
  }));
  const imageCount = entries.reduce((total, entry) => (
    total + entry.sizes.reduce((entryTotal, target) => entryTotal + target.quantity, 0)
  ), 0);
  const shouldShow = visibleStep >= 3 && visibleStep <= totalSteps && entries.length > 0;
  const isInstructionStep = visibleStep === 4 && state.imgCards.length > 0;
  const activeIndex = state.activeInstructionGroup || 0;
  const activeTargetId = state.imgCards[activeIndex]?.targetIds?.[0] || '';

  panel.classList.toggle('is-visible', shouldShow);
  panel.classList.toggle('is-instruction-picker', isInstructionStep);
  menuToggle?.classList.toggle('is-visible', shouldShow);
  siteHeader?.classList.toggle('has-mobile-media-menu', shouldShow);
  if (!shouldShow) {
    closeMobileMediaMenu();
    return;
  }

  const menuItemCount = imageCount;
  if (menuCount) menuCount.textContent = String(menuItemCount);
  if (menuToggle) {
    menuToggle.setAttribute('aria-label', `${isInstructionStep ? '制作画像一覧' : '選択内容'}（${menuItemCount}件）を開く`);
  }

  document.getElementById('floating-media-summary-body').innerHTML = `
    <div class="floating-media-overall">
      <span>${isInstructionStep ? '制作画像を選択' : '選択内容'}</span>
      <strong>${isInstructionStep ? `${imageCount}枚` : `合計 ${imageCount}枚`}</strong>
    </div>
    ${isInstructionStep ? '<div class="floating-media-picker-help">編集する媒体・サイズを選択してください</div>' : ''}
    <div class="floating-media-entry-list">
      ${entries.map(entry => {
        const mediumTotal = entry.sizes.reduce((total, size) => total + size.quantity, 0);
        return `
          <section class="floating-media-entry">
            <div class="floating-media-entry-head">
              <strong>${escHtml(entry.name)}</strong>
              <span>${mediumTotal}枚</span>
            </div>
            <div class="floating-media-size-list">
              ${entry.sizes.length
                ? entry.sizes.map(target => {
                    return `
                    <label class="floating-media-size-row ${isInstructionStep && activeTargetId === target.id ? 'is-active-target' : ''}" data-target-id="${target.id}" ${isInstructionStep ? `onclick="selectInstructionTarget('${target.id}')" role="button" tabindex="0"` : ''}>
                      ${isInstructionStep ? `<i class="floating-media-complete-icon ${isInstructionTargetComplete(target) ? 'is-visible' : ''}" aria-label="入力済み">✓</i>` : ''}
                      <span>${escHtml(target.sizeLabel)}</span>
                      <strong>${target.quantity}枚</strong>
                    </label>`;
                  }).join('')
                : '<div class="floating-media-empty">サイズ未入力</div>'}
            </div>
          </section>`;
      }).join('')}
    </div>`;
}

function setMobileMediaMenuOpen(shouldOpen) {
  const panel = document.getElementById('floating-media-summary');
  const menuToggle = document.getElementById('mobile-summary-menu-toggle');
  const backdrop = document.getElementById('mobile-summary-menu-backdrop');
  if (!panel || !menuToggle || !backdrop) return;

  const canOpen = panel.classList.contains('is-visible') && window.matchMedia('(max-width: 600px)').matches;
  const isOpen = !!shouldOpen && canOpen;
  panel.classList.toggle('is-mobile-open', isOpen);
  menuToggle.classList.toggle('is-open', isOpen);
  menuToggle.setAttribute('aria-expanded', String(isOpen));
  menuToggle.setAttribute('aria-label', isOpen ? '制作画像一覧を閉じる' : '制作画像一覧を開く');
  backdrop.hidden = !isOpen;
  document.body.classList.toggle('mobile-summary-menu-open', isOpen);
}

function toggleMobileMediaMenu() {
  const panel = document.getElementById('floating-media-summary');
  setMobileMediaMenuOpen(!panel?.classList.contains('is-mobile-open'));
}

function closeMobileMediaMenu() {
  setMobileMediaMenuOpen(false);
}

function autoFillImgSize() {
  const imgSizeTextarea = document.getElementById('inp-imgsize');
  const summary = allSelectedSizesFlat();
  imgSizeTextarea.value = summary.join(' / ');
  const count = getTotalImageCount();
  const countInput = document.getElementById('inp-count');
  state.count = count;
  countInput.value = count || '';
  renderFloatingMediaSummary();
}

/* ========== STEP 4: デザイン指示 ========== */
function getMoodGroupOptions(group) {
  return group.sections ? group.sections.flatMap(section => section.options) : group.options;
}

function isMoodOptionDisabled(card, group, moodLabel) {
  if (!group.maxSelections || card.moods.includes(moodLabel)) return false;
  const selectedCount = card.moods.filter(mood => getMoodGroupOptions(group).includes(mood)).length;
  return selectedCount >= group.maxSelections;
}

function initMoodTagsInto(containerId, cardObj, prefix) {
  const tagsWrap = document.getElementById(containerId);
  if (!tagsWrap) return;
  const renderMoodSections = group => `
    ${(group.sections || [{ label: '', options: group.options }]).map(section => `
        <div class="mood-section">
          ${section.label ? `<div class="mood-section-label">${section.label}</div>` : ''}
          <div class="mood-options">
            ${section.options.map(moodLabel => {
              const isSelected = cardObj.moods.includes(moodLabel);
              const isDisabled = isMoodOptionDisabled(cardObj, group, moodLabel);
              return `
              <label class="${isSelected ? 'chk' : ''}${isDisabled ? ' is-disabled' : ''}" data-mood="${escAttr(moodLabel)}" data-mood-group="${group.key}" aria-disabled="${isDisabled}" onclick="toggleCardMood('${prefix}','${escJs(moodLabel)}',this)">
                <input type="checkbox" ${isSelected ? 'checked' : ''} ${isDisabled ? 'disabled' : ''}>${moodLabel}
              </label>`;
            }).join('')}
          </div>
        </div>`).join('')}`;
  const renderOtherInput = (key, label) => `
    <div class="mood-other-field">
      <div class="mood-section-label">その他</div>
      <input type="text" value="${escAttr(cardObj[key])}" placeholder="自由にご記入ください" aria-label="${label}のその他" oninput="updateCardField('${prefix}','${key}',this.value)">
    </div>`;
  const renderMoodGroup = group => group.collapsible ? `
    <details class="mood-collapsible" ${cardObj[group.openKey] ? 'open' : ''} ontoggle="setMoodGroupOpen('${prefix}','${group.openKey}',this.open)">
      <summary><span>${group.label}</span><span class="opt">${group.hint}</span></summary>
      <div class="mood-collapsible-body">${renderMoodSections(group)}${group.key === 'worldview' ? renderOtherInput('worldviewOther', group.label) : ''}</div>
    </details>` : `
    <div class="mood-group">
      <div class="mood-group-label">${group.label}</div>
      <div class="mood-group-hint">${group.hint}</div>
      ${renderMoodSections(group)}
    </div>`;
  const renderInfoDensity = () => `
    <div class="mood-group info-density-group">
      <div class="mood-group-label">情報量・装飾 <span class="opt">未選択でも可</span></div>
      <div class="info-density-options">
        ${INFO_DENSITY_OPTIONS.map(option => `
          <label class="${cardObj.infoDensity === option.label ? 'chk' : ''}">
            <input type="radio" name="info-density-${prefix}" value="${escAttr(option.label)}" ${cardObj.infoDensity === option.label ? 'checked' : ''} onchange="setInfoDensity('${prefix}',this.value)">
            <strong>${option.label}</strong><small>${option.description}</small>
          </label>`).join('')}
      </div>
    </div>`;
  tagsWrap.innerHTML = renderMoodGroup(moodGroups[0]) +
    renderOtherInput('atmosphereOther', '雰囲気') +
    renderInfoDensity() +
    moodGroups.slice(1).map(renderMoodGroup).join('');
}

function normalizeCardDetails(card) {
  if (!card) return card;
  card.moods = Array.isArray(card.moods) ? card.moods : [];
  card.assetFiles = Array.isArray(card.assetFiles) ? card.assetFiles : [];
  const legacyFiles = [
    ...(Array.isArray(card.personFiles) ? card.personFiles : []),
    ...(Array.isArray(card.refFiles) ? card.refFiles : [])
  ];
  legacyFiles.forEach(file => {
    if (!card.assetFiles.some(existing => existing.name === file.name && existing.size === file.size)) {
      card.assetFiles.push(file);
    }
  });
  card.personFiles = [];
  card.refFiles = [];

  if (!card.assetNote) {
    card.assetNote = [card.personFreeNote, card.refNote].filter(Boolean).join('\n');
  }
  card.personFreeNote = '';
  card.refNote = '';
  card.designTxt = stripLegacyDesignInstructionTemplate(card.designTxt);

  const legacyColors = card.moods.map(normalizeColorName).filter(Boolean);
  card.baseColor = normalizeColorName(card.baseColor);
  card.mainColor = normalizeColorName(card.mainColor);
  card.accentColor = normalizeColorName(card.accentColor);
  if (!card.baseColor) card.baseColor = legacyColors[0] || '';
  if (!card.mainColor) card.mainColor = legacyColors[1] || '';
  if (!card.accentColor) card.accentColor = legacyColors[2] || '';
  if (!card.baseColorCode && card.baseColor) card.baseColorCode = COLOR_PRESET_CODES[card.baseColor] || '';
  if (!card.mainColorCode && card.mainColor) card.mainColorCode = COLOR_PRESET_CODES[card.mainColor] || '';
  if (!card.accentColorCode && card.accentColor) card.accentColorCode = COLOR_PRESET_CODES[card.accentColor] || '';
  card.colorNote = card.colorNote || '';
  if (!card.atmosphereOther && card.moodFreeNote) {
    card.atmosphereOther = card.moodFreeNote;
  }
  if (!card.atmosphereOther && card.moodNotes && typeof card.moodNotes === 'object') {
    card.atmosphereOther = [card.moodNotes.elegant, card.moodNotes.friendly, card.moodNotes.sharp].filter(Boolean).join(' / ');
  }
  if (!card.worldviewOther && card.moodNotes?.worldview) card.worldviewOther = card.moodNotes.worldview;
  card.atmosphereOther = card.atmosphereOther || '';
  card.worldviewOther = card.worldviewOther || '';
  card.worldviewOpen = !!card.worldviewOpen;
  delete card.moodNotes;
  delete card.moodFreeNote;
  delete card.seasonOpen;
  delete card.words;
  delete card.highlight;
  card.moods = card.moods.filter(mood => VALID_MOOD_OPTIONS.includes(mood));
  let atmosphereCount = 0;
  card.moods = card.moods.filter(mood => {
    if (ATMOSPHERE_OPTIONS.includes(mood)) {
      atmosphereCount += 1;
      return atmosphereCount <= 2;
    }
    return true;
  });
  card.infoDensity = INFO_DENSITY_OPTIONS.some(option => option.label === card.infoDensity) ? card.infoDensity : '';
  return card;
}

function renderColorOptions(selectedColor) {
  return '<option value="">指定なし</option>' +
    COLOR_OPTIONS.map(color =>
      `<option value="${escAttr(color)}" ${color === selectedColor ? 'selected' : ''}>${escHtml(color)}</option>`
    ).join('');
}

function normalizeColorCode(value) {
  const colorCode = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(colorCode)) return colorCode.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(colorCode)) {
    return `#${colorCode.slice(1).split('').map(char => char + char).join('')}`.toUpperCase();
  }
  return '';
}

function getColorPickerValue(card, colorKey, codeKey) {
  return normalizeColorCode(card[codeKey]) || COLOR_PRESET_CODES[card[colorKey]] || '#FFFFFF';
}

function getCard(prefix) {
  if (prefix === 'common') return state.common;
  const cardIndex = parseInt(prefix.split('-')[1]);
  return state.imgCards[cardIndex];
}

function toggleCardMood(prefix, moodLabel, el) {
  // ネイティブのチェックボックス状態反映を待ってから状態を読み取る
  setTimeout(() => {
    const card = getCard(prefix);
    const input = el.querySelector('input');
    if (input.disabled) return;
    const isChecked = input.checked;
    const group = moodGroups.find(item => getMoodGroupOptions(item).includes(moodLabel));
    if (isChecked && group && isMoodOptionDisabled(card, group, moodLabel)) {
      input.checked = false;
      el.classList.remove('chk');
      return;
    }
    el.classList.toggle('chk', isChecked);
    if (isChecked) { if (!card.moods.includes(moodLabel)) card.moods.push(moodLabel); }
    else { card.moods = card.moods.filter(x => x !== moodLabel); }
    refreshMoodOptionAvailability(prefix);
    refreshInstructionCompletionIndicators();
  }, 10);
}

function refreshMoodOptionAvailability(prefix) {
  const card = getCard(prefix);
  const container = document.getElementById(`moodtags-${prefix}`);
  if (!container || !card) return;
  container.querySelectorAll('label[data-mood]').forEach(label => {
    const moodLabel = label.dataset.mood;
    const group = moodGroups.find(item => item.key === label.dataset.moodGroup);
    const isDisabled = group ? isMoodOptionDisabled(card, group, moodLabel) : false;
    const input = label.querySelector('input');
    input.disabled = isDisabled;
    label.classList.toggle('is-disabled', isDisabled);
    label.setAttribute('aria-disabled', String(isDisabled));
  });
}

function setMoodGroupOpen(prefix, key, isOpen) {
  const card = getCard(prefix);
  if (card) card[key] = isOpen;
}

/* 共通／個別カードのフルテンプレートをHTML文字列で生成 */
function renderCardTemplate(prefix, card, opts) {
  opts = opts || {};
  normalizeCardDetails(card);
  const heading = opts.heading || '';
  const isIndividual = !!opts.individual;
  const canRemove = isIndividual && !!opts.canRemove;
  const idx = opts.idx != null ? opts.idx : '';
  const collapsed = isIndividual && !!card.collapsed;
  const personUsage = card.personUsage || (card.person === '使用しない' ? '使用しない' : (card.person ? '使用する' : ''));
  const currentTargetId = card.targetIds?.[0];
  const currentTarget = prefix.startsWith('card-')
    ? getInstructionTargets().find(target => target.id === currentTargetId)
    : null;
  const currentTargetLabel = currentTarget
    ? `${currentTarget.displayName}／${currentTarget.sizeLabel}`
    : '同じ媒体・サイズ';
  const sameTargetRemaining = prefix.startsWith('card-')
    ? state.imgCards.filter(item => item !== card && item.targetIds?.[0] === currentTargetId).length
    : 0;
  const unenteredRemaining = prefix.startsWith('card-')
    ? state.imgCards.filter(item => item !== card && !cardHasAnyInput(item)).length
    : 0;
  const canCopyInstruction = state.imgCards.length > 1 && !card.sameAsCardKey && hasRequiredInstruction(card);
  return `
    ${heading ? `
      <div class="img-card-head">
        <div class="img-card-num">${opts.num || ''}</div>
        <div class="img-card-label">${heading}</div>
        ${collapsed && card.targetImage ? `<div class="img-card-tag">${escHtml(card.targetImage)}</div>` : ''}
        ${isIndividual ? `<div class="img-card-toggle" onclick="toggleImgCard(${idx})"><i class="ti ti-chevron-${collapsed ? 'down' : 'up'}"></i> ${collapsed ? '開く' : '閉じる'}</div>` : ''}
        ${canRemove ? `<div class="img-card-remove" onclick="removeImgCard(${idx})"><i class="ti ti-trash"></i> 削除</div>` : ''}
      </div>
      <div class="img-card-body${collapsed ? '' : ' open'}">` : ''}
    ${isIndividual ? `
    <div class="field">
      <div class="lbl">対象画像 <span class="req">必須</span></div>
      <input type="text" class="control-w-md" placeholder="例：メイン画像・700×300 / 全画像共通" value="${escAttr(card.targetImage)}" oninput="updateCardField('${prefix}','targetImage',this.value)">
      <div class="hint">どの画像・サイズへの指示かを明記してください（例：メイン、バナー700×300）</div>
    </div>` : ''}
    <div class="field" id="f-person-${prefix}">
      <div class="person-photo-question-row">
        <div class="lbl">人物写真を使用しますか <span class="req">必須</span></div>
        <div class="radios person-photo-modes">
          <div class="rbtn ${personUsage === '使用する' ? 'sel' : ''}" onclick="setPersonUsage('${prefix}','使用する')">使用する</div>
          <div class="rbtn ${personUsage === '使用しない' ? 'sel' : ''}" onclick="setPersonUsage('${prefix}','使用しない')">使用しない</div>
        </div>
      </div>
      <div class="person-staff-photo-option" style="display:${personUsage === '使用する' ? 'block' : 'none'}">
        <label class="person-staff-photo-check">
          <input type="checkbox" ${card.staffPhotoAllowed ? 'checked' : ''} onchange="updateCardField('${prefix}','staffPhotoAllowed',this.checked)">
          <span>在籍写真の使用【可能】</span>
        </label>
      </div>
      <div class="err">人物写真を使用するか選択してください</div>
    </div>

    <div class="field unified-assets-field">
      <div class="lbl">参考資料・素材 <span class="opt">任意</span></div>
      <textarea class="control-w-lg" placeholder="人物素材や参考画像、参考URL、画像IDなど、制作の参考となる情報をご記入ください。" oninput="updateCardField('${prefix}','assetNote',this.value)" style="min-height:84px">${escHtml(card.assetNote)}</textarea>
      <div class="upload-box small" onclick="document.getElementById('af-${prefix}').click()" ondragover="handleUploadDragOver(event)" ondragleave="handleUploadDragLeave(event)" ondrop="handleAssetFileDrop(event,'${prefix}')">
        <svg class="upload-icon upload-icon-prominent" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <path d="M21.5 50H16a14 14 0 1 1 3.2-27.6A17.5 17.5 0 0 1 52.4 29 12 12 0 0 1 48 52H42"></path>
          <path d="M32 51V25"></path>
          <path d="m22 35 10-10 10 10"></path>
        </svg>
        <div class="upload-main">参考資料・素材をクリックまたはドラッグ＆ドロップ</div>
        <div class="upload-sub">PNG / JPG / WEBP / PDF / TXT / ZIP など · 各20MBまで</div>
      </div>
      <input type="file" id="af-${prefix}" multiple accept="${REFERENCE_FILE_ACCEPT}" style="display:none" onchange="handleAssetFiles('${prefix}',this)">
      <div class="flist" id="af-list-${prefix}"></div>
      <div class="err upload-error" id="af-error-${prefix}"></div>
    </div>
    <div class="field" id="f-designtxt-${prefix}">
      <div class="lbl">掲載文言・デザイン指示 <span class="req">必須</span></div>
      <textarea class="control-w-lg design-instruction-textarea" placeholder="例：添付のオープンイベントバナーを参考に、開催日を9/11・9/25へ変更してください。掲載文言は「9月オープンイベント／3000円割引＋10分／70分16,000円」でお願いします。" oninput="updateDesignInstruction('${prefix}',this.value,this)">${escHtml(card.designTxt)}</textarea>
      <div class="err">掲載文言またはデザイン指示を入力してください</div>
    </div>
    <details class="advanced-instructions" ${card.advancedOpen ? 'open' : ''} ontoggle="setAdvancedInstructionsOpen('${prefix}',this.open)">
      <summary><span>詳しい指示を設定する</span><span class="opt">任意</span></summary>
      <div class="advanced-instructions-body">
        <div class="advanced-instructions-toolbar">
          <span>カラー・雰囲気・世界観などの詳細設定</span>
          <button type="button" onclick="resetAdvancedInstructions('${prefix}')"><i class="ti ti-restore"></i>詳細設定をリセット</button>
        </div>
        <div class="lbl">カラーの方向性 <span class="opt">任意</span></div>
        <div class="color-role-grid">
          <label class="color-role-field">
            <span><strong>ベースカラー</strong><small><b class="color-ratio">70%</b>・背景や広い面積</small></span>
            <select onchange="setColorPreset('${prefix}','baseColor','baseColorCode',this.value)">${renderColorOptions(card.baseColor)}</select>
            <span class="color-code-control">
              <input type="color" id="baseColorCode-picker-${prefix}" value="${getColorPickerValue(card, 'baseColor', 'baseColorCode')}" aria-label="ベースカラーのカラーピッカー" onchange="setColorPicker('${prefix}','baseColorCode',this.value)">
              <input type="text" id="baseColorCode-code-${prefix}" class="color-code-input" value="${escAttr(card.baseColorCode)}" maxlength="7" placeholder="#FFFFFF" aria-label="ベースカラーのカラーコード" oninput="updateColorCode('${prefix}','baseColorCode',this.value)">
            </span>
          </label>
          <label class="color-role-field">
            <span><strong>メインカラー</strong><small><b class="color-ratio">25%</b>・印象の中心</small></span>
            <select onchange="setColorPreset('${prefix}','mainColor','mainColorCode',this.value)">${renderColorOptions(card.mainColor)}</select>
            <span class="color-code-control">
              <input type="color" id="mainColorCode-picker-${prefix}" value="${getColorPickerValue(card, 'mainColor', 'mainColorCode')}" aria-label="メインカラーのカラーピッカー" onchange="setColorPicker('${prefix}','mainColorCode',this.value)">
              <input type="text" id="mainColorCode-code-${prefix}" class="color-code-input" value="${escAttr(card.mainColorCode)}" maxlength="7" placeholder="#FFFFFF" aria-label="メインカラーのカラーコード" oninput="updateColorCode('${prefix}','mainColorCode',this.value)">
            </span>
          </label>
          <label class="color-role-field">
            <span><strong>アクセントカラー</strong><small><b class="color-ratio">5%</b>・強調や差し色</small></span>
            <select onchange="setColorPreset('${prefix}','accentColor','accentColorCode',this.value)">${renderColorOptions(card.accentColor)}</select>
            <span class="color-code-control">
              <input type="color" id="accentColorCode-picker-${prefix}" value="${getColorPickerValue(card, 'accentColor', 'accentColorCode')}" aria-label="アクセントカラーのカラーピッカー" onchange="setColorPicker('${prefix}','accentColorCode',this.value)">
              <input type="text" id="accentColorCode-code-${prefix}" class="color-code-input" value="${escAttr(card.accentColorCode)}" maxlength="7" placeholder="#FFFFFF" aria-label="アクセントカラーのカラーコード" oninput="updateColorCode('${prefix}','accentColorCode',this.value)">
            </span>
          </label>
        </div>
        <div class="color-direction-hint">
          色名とカラーコードの指定が異なる場合は、カラーコードを優先して制作します。指定した色を参考に、制作側で全体のバランスに合わせて色を選定する場合があります。
        </div>
        <div class="color-direction-note">
          <div class="lbl">カラーについての補足 <span class="opt">任意</span></div>
          <textarea class="control-w-lg" placeholder="例：全体は落ち着いた色味、赤は使用しない、指定色に近い範囲で調整可能など" oninput="updateCardField('${prefix}','colorNote',this.value)">${escHtml(card.colorNote)}</textarea>
        </div>
        <div class="advanced-instructions-divider"></div>
        <div class="tag-chk" id="moodtags-${prefix}"></div>
      </div>
    </details>
    ${prefix.startsWith('card-') ? `
      <div class="instruction-apply-all-footer">
        <div class="instruction-reset-actions">
          <button type="button" class="instruction-reset-card instruction-reset-card-footer" onclick="resetCurrentInstructionCard()">
            この画像の指示をリセット
          </button>
        </div>
        <details class="instruction-copy-menu">
          <summary class="instruction-apply-all ${canCopyInstruction ? '' : 'is-disabled'}" ${canCopyInstruction ? '' : 'onclick="event.preventDefault()"'} title="${canCopyInstruction ? 'コピー先を選択' : 'この画像の必須項目を入力すると使用できます'}">
            <span class="copy-action-icon" aria-hidden="true"></span>
            コピー先を選ぶ
            <span class="instruction-copy-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div class="instruction-copy-options">
            ${sameTargetRemaining > 0 ? `
              <button type="button" onclick="applyInstructionToCurrentTarget()">
                <strong>同じサイズの残り${sameTargetRemaining}枚にコピー</strong>
                <small>${escHtml(currentTargetLabel)}のみ</small>
              </button>` : ''}
            <button type="button" onclick="applyInstructionToUnenteredImages()" ${unenteredRemaining ? '' : 'disabled'}>
              <strong>すべての未入力画像にコピー${unenteredRemaining ? `（${unenteredRemaining}枚）` : ''}</strong>
              <small>${unenteredRemaining ? '媒体・サイズを問わずコピーします。入力済みの画像は変更しません' : '未入力の制作画像はありません'}</small>
            </button>
          </div>
        </details>
      </div>` : ''}
    ${heading ? `</div>` : ''}
  `;
}

function renderCommonBlock() {
  const commonBlockWrap = document.querySelector('#common-instructions-wrap .design-instruction-block');
  commonBlockWrap.innerHTML = renderCardTemplate('common', state.common);
  initMoodTagsInto('moodtags-common', state.common, 'common');
  renderCardFileLists('common', state.common);
}

function setPersonUsage(prefix, usage) {
  const card = getCard(prefix);
  if (!card) return;
  card.personUsage = usage;
  card.person = usage === '使用する' ? '人物写真を使用する' : '使用しない';
  rerenderDesignInstructions();
}

function updatePersonPhotoField(prefix, key, value) {
  const card = getCard(prefix);
  card[key] = value;
  if (card.person) document.getElementById(`f-person-${prefix}`).classList.remove('inv');
}

function rerenderDesignInstructions() {
  if (state.imgMode === 'images' && state.imgCards.length) renderInstructionGroups();
  else renderCommonBlock();
}

function renderCardFileLists(prefix, card) {
  normalizeCardDetails(card);
  renderFileTags(`af-list-${prefix}`, card.assetFiles, (i) => removeCardFile(prefix, 'assetFiles', i, `af-list-${prefix}`));
}

function setCardDesign(prefix, value, el) {
  const card = getCard(prefix);
  card.design = value;
  document.querySelectorAll(`#f-design-${prefix} .radios .rbtn`).forEach(btn => btn.classList.remove('sel'));
  el.classList.add('sel');
  document.getElementById(`ref-block-${prefix}`).style.display = value === '参考画像あり' ? 'block' : 'none';
  document.getElementById(`f-design-${prefix}`).classList.remove('inv');
  const designTxtEl = document.querySelector(`#f-designtxt-${prefix} textarea`);
  if (value === 'おまかせ') {
    card.designTxt = `${DESIGN_INSTRUCTION_TEMPLATE}おまかせ`;
    designTxtEl.value = card.designTxt;
    document.getElementById(`f-designtxt-${prefix}`).classList.remove('inv');
  } else if (designTxtEl.value === `${DESIGN_INSTRUCTION_TEMPLATE}おまかせ`) {
    card.designTxt = DESIGN_INSTRUCTION_TEMPLATE;
    designTxtEl.value = DESIGN_INSTRUCTION_TEMPLATE;
  }
}

function updateCardField(prefix, key, value) {
  getCard(prefix)[key] = value;
  refreshInstructionCompletionIndicators();
}

function updateDesignInstruction(prefix, value, element) {
  const card = getCard(prefix);
  if (!card) return;
  const nextValue = ensureDesignInstructionTemplate(value);
  card.designTxt = nextValue;
  if (element.value !== nextValue) {
    element.value = nextValue;
    element.setSelectionRange(nextValue.length, nextValue.length);
  }
  document.getElementById(`f-designtxt-${prefix}`)?.classList.remove('inv');
  if (instructionNotice) {
    instructionNotice = '';
    document.querySelector('.instruction-inline-notice')?.remove();
  }
  refreshInstructionCompletionIndicators();
}

function setInfoDensity(prefix, value) {
  const card = getCard(prefix);
  card.infoDensity = value;
  const container = document.getElementById(`moodtags-${prefix}`);
  if (container) {
    container.querySelectorAll('.info-density-options label').forEach(label => {
      label.classList.toggle('chk', label.querySelector('input').value === value);
    });
  }
  refreshInstructionCompletionIndicators();
}

function setColorPreset(prefix, colorKey, codeKey, colorName) {
  const card = getCard(prefix);
  card[colorKey] = colorName;
  card[codeKey] = colorName ? (COLOR_PRESET_CODES[colorName] || '') : '';
  const picker = document.getElementById(`${codeKey}-picker-${prefix}`);
  const codeInput = document.getElementById(`${codeKey}-code-${prefix}`);
  if (picker) picker.value = card[codeKey] || '#FFFFFF';
  if (codeInput) {
    codeInput.value = card[codeKey];
    codeInput.classList.remove('invalid');
  }
  refreshInstructionCompletionIndicators();
}

function setColorPicker(prefix, codeKey, value) {
  const colorCode = normalizeColorCode(value);
  const card = getCard(prefix);
  card[codeKey] = colorCode;
  const codeInput = document.getElementById(`${codeKey}-code-${prefix}`);
  if (codeInput) {
    codeInput.value = colorCode;
    codeInput.classList.remove('invalid');
  }
  refreshInstructionCompletionIndicators();
}

function updateColorCode(prefix, codeKey, value) {
  const card = getCard(prefix);
  const colorCode = normalizeColorCode(value);
  card[codeKey] = colorCode || value.trim().toUpperCase();
  const codeInput = document.getElementById(`${codeKey}-code-${prefix}`);
  const picker = document.getElementById(`${codeKey}-picker-${prefix}`);
  if (codeInput) codeInput.classList.toggle('invalid', !!value && !colorCode);
  if (picker && colorCode) picker.value = colorCode;
  refreshInstructionCompletionIndicators();
}

function setAdvancedInstructionsOpen(prefix, isOpen) {
  const card = getCard(prefix);
  if (card) card.advancedOpen = isOpen;
}

function resetAdvancedInstructions(prefix) {
  const card = getCard(prefix);
  if (!card || !window.confirm('詳しい指示の設定をすべてリセットしますか？')) return;
  card.baseColor = '';
  card.mainColor = '';
  card.accentColor = '';
  card.baseColorCode = '';
  card.mainColorCode = '';
  card.accentColorCode = '';
  card.colorNote = '';
  card.moods = [];
  card.infoDensity = '';
  card.atmosphereOther = '';
  card.worldviewOther = '';
  card.worldviewOpen = false;
  card.advancedOpen = true;
  renderInstructionGroups();
  saveDraft();
}

function handlePersonFiles(prefix, inp) {
  addPersonFiles(prefix, inp.files);
  inp.value = '';
}

function addPersonFiles(prefix, files) {
  const card = getCard(prefix);
  const errorEl = document.getElementById(`pf-error-${prefix}`);
  const errors = [];
  Array.from(files || []).forEach(file => {
    const extension = file.name.split('.').pop().toLowerCase();
    if (!PERSON_FILE_EXTENSIONS.includes(extension)) errors.push(`${file.name}：対応していない形式です`);
    else if (file.size > MAX_REFERENCE_FILE_SIZE) errors.push(`${file.name}：20MBを超えています`);
    else if (!card.personFiles.find(existingFile => existingFile.name === file.name)) card.personFiles.push(file);
  });
  errorEl.textContent = errors.join(' / ');
  errorEl.style.display = errors.length ? 'block' : 'none';
  if (card.personFiles.length) {
    card.personUsage = '使用する';
    card.person = '人物写真を使用する';
    document.getElementById(`f-person-${prefix}`).classList.remove('inv');
  }
  renderFileTags(`pf-list-${prefix}`, card.personFiles, (i) => removeCardFile(prefix, 'personFiles', i, `pf-list-${prefix}`));
}

function handleRefFiles(prefix, inp) {
  addRefFiles(prefix, inp.files);
  inp.value = '';
}

function handleAssetFiles(prefix, inp) {
  addAssetFiles(prefix, inp.files);
  inp.value = '';
}

function handleBulkAssetFiles(input) {
  addBulkAssetFiles(input.files);
  input.value = '';
}

function addBulkAssetFiles(files) {
  state.bulkAssetFiles = Array.isArray(state.bulkAssetFiles) ? state.bulkAssetFiles : [];
  const errorEl = document.getElementById('bulk-asset-error');
  const errors = [];
  Array.from(files || []).forEach(file => {
    const extension = file.name.split('.').pop().toLowerCase();
    if (!REFERENCE_FILE_EXTENSIONS.includes(extension)) errors.push(`${file.name}：対応していない形式です`);
    else if (file.size > MAX_REFERENCE_FILE_SIZE) errors.push(`${file.name}：20MBを超えています`);
    else if (!state.bulkAssetFiles.find(existingFile => existingFile.name === file.name)) {
      state.bulkAssetFiles.push(file);
    }
  });
  errorEl.textContent = errors.join(' / ');
  errorEl.style.display = errors.length ? 'block' : 'none';
  renderBulkAssetFiles();
}

function handleBulkAssetFileDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove('is-dragover');
  addBulkAssetFiles(event.dataTransfer.files);
}

function removeBulkAssetFile(index) {
  const [removedFile] = state.bulkAssetFiles.splice(index, 1);
  const previewUrl = removedFile ? filePreviewUrls.get(removedFile) : '';
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    filePreviewUrls.delete(removedFile);
  }
  renderBulkAssetFiles();
}

function renderBulkAssetFiles() {
  state.bulkAssetFiles = Array.isArray(state.bulkAssetFiles) ? state.bulkAssetFiles : [];
  renderFileTags('bulk-asset-file-list', state.bulkAssetFiles, removeBulkAssetFile);
}

function addAssetFiles(prefix, files) {
  const card = normalizeCardDetails(getCard(prefix));
  const errorEl = document.getElementById(`af-error-${prefix}`);
  const errors = [];
  Array.from(files || []).forEach(file => {
    const extension = file.name.split('.').pop().toLowerCase();
    if (!REFERENCE_FILE_EXTENSIONS.includes(extension)) errors.push(`${file.name}：対応していない形式です`);
    else if (file.size > MAX_REFERENCE_FILE_SIZE) errors.push(`${file.name}：20MBを超えています`);
    else if (!card.assetFiles.find(existingFile => existingFile.name === file.name)) card.assetFiles.push(file);
  });
  errorEl.textContent = errors.join(' / ');
  errorEl.style.display = errors.length ? 'block' : 'none';
  renderFileTags(`af-list-${prefix}`, card.assetFiles, (i) => removeCardFile(prefix, 'assetFiles', i, `af-list-${prefix}`));
}

function addRefFiles(prefix, files) {
  const card = getCard(prefix);
  const errorEl = document.getElementById(`rf-error-${prefix}`);
  const errors = [];
  Array.from(files || []).forEach(file => {
    const extension = file.name.split('.').pop().toLowerCase();
    if (!REFERENCE_FILE_EXTENSIONS.includes(extension)) errors.push(`${file.name}：対応していない形式です`);
    else if (file.size > MAX_REFERENCE_FILE_SIZE) errors.push(`${file.name}：20MBを超えています`);
    else if (!card.refFiles.find(existingFile => existingFile.name === file.name)) card.refFiles.push(file);
  });
  errorEl.textContent = errors.join(' / ');
  errorEl.style.display = errors.length ? 'block' : 'none';
  renderFileTags(`rf-list-${prefix}`, card.refFiles, (i) => removeCardFile(prefix, 'refFiles', i, `rf-list-${prefix}`));
}

function handleUploadDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  event.currentTarget.classList.add('is-dragover');
}

function handleUploadDragLeave(event) {
  event.currentTarget.classList.remove('is-dragover');
}

function handlePersonFileDrop(event, prefix) {
  event.preventDefault();
  event.currentTarget.classList.remove('is-dragover');
  addPersonFiles(prefix, event.dataTransfer.files);
}

function handleRefFileDrop(event, prefix) {
  event.preventDefault();
  event.currentTarget.classList.remove('is-dragover');
  addRefFiles(prefix, event.dataTransfer.files);
}

function handleAssetFileDrop(event, prefix) {
  event.preventDefault();
  event.currentTarget.classList.remove('is-dragover');
  addAssetFiles(prefix, event.dataTransfer.files);
}

function removeCardFile(prefix, key, i, listId) {
  const card = getCard(prefix);
  const [removedFile] = card[key].splice(i, 1);
  const previewUrl = removedFile ? filePreviewUrls.get(removedFile) : '';
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    filePreviewUrls.delete(removedFile);
  }
  renderFileTags(listId, card[key], (j) => removeCardFile(prefix, key, j, listId));
}

function getFilePreviewUrl(file) {
  const extension = (file?.name || '').split('.').pop().toLowerCase();
  if (!file || !PREVIEWABLE_IMAGE_EXTENSIONS.includes(extension)) return '';
  if (!filePreviewUrls.has(file)) filePreviewUrls.set(file, URL.createObjectURL(file));
  return filePreviewUrls.get(file);
}

function getFileIconClass(file) {
  const extension = (file?.name || '').split('.').pop().toLowerCase();
  if (extension === 'pdf') return 'ti-file-type-pdf';
  if (extension === 'txt') return 'ti-file-text';
  if (ARCHIVE_FILE_EXTENSIONS.includes(extension)) return 'ti-file-zip';
  return 'ti-file';
}

function renderFileTags(listId, files, onRemove) {
  const listEl = document.getElementById(listId);
  if (!listEl) return;
  listEl.innerHTML = files.map((file, i) => {
    const previewUrl = getFilePreviewUrl(file);
    return `
      <div class="file-preview-card">
        <div class="file-preview-thumb">
          ${previewUrl
            ? `<img src="${escAttr(previewUrl)}" alt="${escAttr(file.name)}">`
            : `<i class="ti ${getFileIconClass(file)}"></i>`}
        </div>
        <button type="button" class="file-preview-remove" data-i="${i}" aria-label="${escAttr(file.name)}を削除">×</button>
        <div class="file-preview-name" title="${escAttr(file.name)}">${escHtml(file.name)}</div>
        <div class="file-preview-size">${(file.size / 1024 / 1024).toFixed(1)}MB</div>
      </div>`;
  }).join('');
  listEl.querySelectorAll('.file-preview-remove').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      onRemove(parseInt(button.dataset.i));
    });
  });
}

/* 媒体・サイズごとに制作画像の指示カードを管理 */
function getInstructionTargets() {
  const targets = [];
  state.selectedMedia.forEach((mediumName, mediumIndex) => {
    getSelectedSizeEntriesForMedium(mediumName).forEach((entry, sizeIndex) => {
      targets.push({
        id: `target-${mediumIndex}-${sizeIndex}`,
        mediumName,
        displayName: getMediumDisplayName(mediumName),
        sizeLabel: entry.label,
        quantity: entry.quantity,
        sourceType: entry.sourceType,
        sourceKey: entry.sourceKey,
        sourceIndex: entry.sourceIndex
      });
    });
  });
  return targets;
}

function cardHasInstruction(card) {
  normalizeCardDetails(card);
  return !!(card.personUsage || card.design || hasDesignInstructionContent(card.designTxt) || card.assetNote ||
    card.moods.length || card.atmosphereOther || card.worldviewOther || card.infoDensity || card.baseColor ||
    card.mainColor || card.accentColor || card.baseColorCode || card.mainColorCode ||
    card.accentColorCode || card.colorNote || card.sameAsCardKey);
}

function cloneInstructionCard(card) {
  const clonedCard = {
    ...makeBlankCard(),
    ...(card || {}),
    personFiles: card?.personFiles || [],
    refFiles: card?.refFiles || [],
    assetFiles: card?.assetFiles || []
  };
  return normalizeCardDetails(clonedCard);
}

function getInstructionCardKey(card) {
  return `${card?.targetIds?.[0] || ''}::${Number(card?.imageNumber) || 1}`;
}

function findInstructionCardByKey(cardKey) {
  return state.imgCards.find(card => getInstructionCardKey(card) === cardKey);
}

function resolveInstructionCard(card, visitedKeys = new Set()) {
  if (!card) return null;
  const cardKey = getInstructionCardKey(card);
  if (visitedKeys.has(cardKey)) return null;
  if (!card.sameAsCardKey) return card;
  visitedKeys.add(cardKey);
  return resolveInstructionCard(findInstructionCardByKey(card.sameAsCardKey), visitedKeys);
}

function hasRequiredInstruction(card) {
  const effectiveCard = resolveInstructionCard(card);
  if (!effectiveCard) return false;
  const usage = effectiveCard.personUsage ||
    (effectiveCard.person === '使用しない' ? '使用しない' : (effectiveCard.person ? '使用する' : ''));
  return !!(usage && hasDesignInstructionContent(effectiveCard.designTxt));
}

function isInstructionTargetComplete(target) {
  if (!target) return false;
  const targetCards = state.imgCards
    .filter(card => card.targetIds?.[0] === target.id)
    .sort((a, b) => (Number(a.imageNumber) || 1) - (Number(b.imageNumber) || 1));
  return targetCards.length >= target.quantity &&
    targetCards.slice(0, target.quantity).every(hasRequiredInstruction);
}

function refreshInstructionCompletionIndicators() {
  const completionByTargetId = new Map(
    getInstructionTargets().map(target => [target.id, isInstructionTargetComplete(target)])
  );
  document.querySelectorAll('[data-target-id]').forEach(element => {
    const isComplete = !!completionByTargetId.get(element.dataset.targetId);
    element.classList.toggle('is-complete', isComplete);
    const icon = element.querySelector('.instruction-complete-icon, .floating-media-complete-icon');
    icon?.classList.toggle('is-visible', isComplete);
  });
  const applyAllButton = document.querySelector('.instruction-apply-all');
  const activeCard = state.imgCards[state.activeInstructionGroup];
  if (applyAllButton && activeCard) {
    const canApplyToAll = state.imgCards.length > 1 &&
      !activeCard.sameAsCardKey &&
      hasRequiredInstruction(activeCard);
    applyAllButton.classList.toggle('is-disabled', !canApplyToAll);
    applyAllButton.onclick = canApplyToAll ? null : event => event.preventDefault();
    applyAllButton.title = canApplyToAll
      ? 'この指示をほかのすべての制作画像に適用'
      : 'この画像の必須項目を入力すると使用できます';
  }
}

function getInstructionCardLabel(card, targets = getInstructionTargets()) {
  const target = targets.find(item => item.id === card?.targetIds?.[0]);
  if (!target) return '制作画像';
  return `${target.displayName}／${target.sizeLabel}${target.quantity > 1 ? `／${card.imageNumber || 1}枚目` : ''}`;
}

function syncInstructionGroups() {
  const targets = getInstructionTargets();
  const previousCards = Array.isArray(state.imgCards) ? state.imgCards : [];
  const activeCard = previousCards[state.activeInstructionGroup];
  const activeTargetId = activeCard?.targetIds?.[0];
  const activeImageNumber = Number(activeCard?.imageNumber) || 1;
  const fallbackCard = previousCards.find(cardHasInstruction) || state.common || makeBlankCard();
  const rebuiltCards = [];

  targets.forEach(target => {
    const exactCards = previousCards
      .filter(card => card.targetIds?.length === 1 && card.targetIds[0] === target.id)
      .sort((a, b) => (Number(a.imageNumber) || 1) - (Number(b.imageNumber) || 1));
    const sharedLegacyCard = previousCards.find(card => card.targetIds?.includes(target.id));
    const sourceCards = exactCards.length
      ? exactCards
      : (sharedLegacyCard ? [sharedLegacyCard] : []);
    const cardCount = target.quantity;

    for (let imageIndex = 0; imageIndex < cardCount; imageIndex += 1) {
      const sourceCard = sourceCards[imageIndex] ||
        (!previousCards.length && imageIndex === 0 ? fallbackCard : makeBlankCard());
      rebuiltCards.push({
        ...cloneInstructionCard(sourceCard),
        targetIds: [target.id],
        imageNumber: imageIndex + 1
      });
    }
  });

  state.imgCards = rebuiltCards;
  const validCardKeys = new Set(state.imgCards.map(getInstructionCardKey));
  state.imgCards.forEach(card => {
    if (card.sameAsCardKey &&
        (!validCardKeys.has(card.sameAsCardKey) || card.sameAsCardKey === getInstructionCardKey(card))) {
      card.sameAsCardKey = '';
    }
  });
  state.imgMode = 'images';
  const restoredActiveIndex = state.imgCards.findIndex(card =>
    card.targetIds?.[0] === activeTargetId &&
    (Number(card.imageNumber) || 1) === activeImageNumber
  );
  state.activeInstructionGroup = restoredActiveIndex >= 0
    ? restoredActiveIndex
    : Math.min(Math.max(Number(state.activeInstructionGroup) || 0, 0), Math.max(state.imgCards.length - 1, 0));
  renderInstructionGroups();
}

function renderInstructionGroups() {
  const tabs = document.getElementById('instruction-group-tabs');
  const targets = getInstructionTargets();
  if (!state.imgCards.length) {
    state.imgCards = [makeBlankCard()];
    state.activeInstructionGroup = 0;
  }
  const activeIndex = state.activeInstructionGroup;
  const activeCard = state.imgCards[activeIndex] || state.imgCards[0] || makeBlankCard();
  if (activeCard.sameAsCardKey && !resolveInstructionCard(activeCard)) {
    activeCard.sameAsCardKey = '';
  }
  const activeTargetId = activeCard.targetIds?.[0] || targets[0]?.id || '';
  const activeTarget = targets.find(target => target.id === activeTargetId) || targets[0];
  const targetIndex = Math.max(targets.findIndex(target => target.id === activeTarget?.id), 0);
  const cardsForTarget = state.imgCards
    .map((card, index) => ({ card, index }))
    .filter(item => item.card.targetIds?.[0] === activeTarget?.id)
    .sort((a, b) => (Number(a.card.imageNumber) || 1) - (Number(b.card.imageNumber) || 1));
  const reusableCards = state.imgCards
    .map((card, index) => ({ card, index }))
    .filter(item => {
      if (item.index === activeIndex) return false;
      const resolvedCard = resolveInstructionCard(item.card);
      return resolvedCard && resolvedCard !== activeCard;
    });
  const reuseSource = activeCard.sameAsCardKey
    ? findInstructionCardByKey(activeCard.sameAsCardKey)
    : null;
  const reuseSourceHasInstruction = reuseSource ? hasRequiredInstruction(reuseSource) : false;

  tabs.classList.add('instruction-image-navigation');
  tabs.innerHTML = `
    <div class="instruction-image-targets">
      ${targets.map((target, index) => {
        const targetLabel = splitSizeSuggestion(target.sizeLabel);
        return `
          <button type="button" class="instruction-image-target instruction-color-${index % 6} ${target.id === activeTarget?.id ? 'is-active' : ''} ${isInstructionTargetComplete(target) ? 'is-complete' : ''}" data-target-id="${target.id}" onclick="selectInstructionTarget('${target.id}')">
            <span>${escHtml(target.displayName)}</span>
            <span class="instruction-image-meta">
              ${targetLabel.title ? `<strong>${escHtml(targetLabel.title)}</strong>` : ''}
              ${targetLabel.plan ? `<em>${escHtml(targetLabel.plan)}</em>` : ''}
            </span>
            <b class="instruction-image-dimension">${escHtml(targetLabel.dimension)}</b>
            <small>${target.quantity}枚</small>
            <i class="instruction-complete-icon ${isInstructionTargetComplete(target) ? 'is-visible' : ''}" aria-label="入力済み">✓</i>
          </button>`;
      }).join('')}
    </div>
    ${activeTarget?.quantity > 1 ? `
      <div class="instruction-copy-nav">
        <span class="instruction-copy-label">画像別の指示</span>
        <div class="instruction-copy-tabs">
          ${cardsForTarget.map(({ card, index }) => `
            <div class="instruction-group-tab-shell instruction-color-${targetIndex % 6} ${index === activeIndex ? 'is-active' : ''}">
              <button type="button" class="instruction-group-tab" onclick="selectInstructionGroup(${index})">
                <span>${card.imageNumber}枚目</span>
              </button>
            </div>`).join('')}
        </div>
        <span class="instruction-copy-status is-complete">${cardsForTarget.length}/${activeTarget.quantity}枚分</span>
      </div>` : ''}
  `;

  const wrap = document.querySelector('#common-instructions-wrap .design-instruction-block');
  document.getElementById('common-instructions-wrap').classList.toggle('is-tabbed', activeTarget?.quantity > 1);
  wrap.innerHTML = `
    <div class="instruction-group-current instruction-color-${targetIndex % 6}">
      <div>
        <span>編集中</span>
        <strong>${activeTarget ? `${escHtml(activeTarget.displayName)}／${escHtml(activeTarget.sizeLabel)}` : '制作画像'}</strong>
      </div>
      <p>${activeTarget?.quantity > 1 ? `${activeCard.imageNumber || 1}枚目の指示` : 'この制作画像の指示'}</p>
    </div>
    ${instructionNotice ? `<div class="instruction-inline-notice" role="status">${escHtml(instructionNotice)}</div>` : ''}
    ${reusableCards.length ? `
      <div class="instruction-reuse-entry ${activeCard.sameAsCardKey ? 'is-active' : ''}">
        <label class="instruction-reuse-check">
          <input type="checkbox" ${activeCard.sameAsCardKey ? 'checked' : ''} onchange="setInstructionReuse(this.checked)">
          <span>他の制作画像と同じ指示にする</span>
        </label>
        <small>${activeCard.sameAsCardKey ? '参照する画像を選んでください' : '同じ内容なら入力を省略できます'}</small>
      </div>` : ''}
    ${activeCard.sameAsCardKey ? `
      <div class="instruction-reuse-control is-active ${reuseSourceHasInstruction ? '' : 'is-invalid'}">
          <div class="instruction-reuse-source">
            <label for="instruction-reuse-select">同じ指示を使う画像</label>
            <select id="instruction-reuse-select" onchange="setInstructionReuseSource(this.value)">
              ${reusableCards.map(({ card }) => `
                <option value="${escAttr(getInstructionCardKey(card))}" ${getInstructionCardKey(card) === activeCard.sameAsCardKey ? 'selected' : ''}>${escHtml(getInstructionCardLabel(card, targets))}${hasRequiredInstruction(card) ? '' : '（指示未入力）'}</option>
              `).join('')}
            </select>
            ${reuseSourceHasInstruction ? '' : '<div class="instruction-reuse-error" role="alert">選択した画像の指示が未入力または未完了です。先に参照元の指示を入力してください。</div>'}
            <p class="instruction-reuse-release-note">「他の制作画像と同じ指示にする」を解除すると、参照元の内容は引き継がれず、この画像の個別入力へ切り替わります。</p>
          </div>
      </div>` : ''}
    ${activeCard.sameAsCardKey ? `
      <div class="instruction-reuse-summary ${reuseSourceHasInstruction ? '' : 'is-invalid'}">
        <span>${reuseSourceHasInstruction ? '同じ指示を設定済み' : '参照元の入力待ち'}</span>
        <strong>${escHtml(getInstructionCardLabel(reuseSource, targets))}</strong>
        <p>${reuseSourceHasInstruction ? '選択した制作画像の指示内容が、そのまま適用されます。' : '参照元の指示を入力すると、この制作画像にも同じ内容が適用されます。'}</p>
      </div>
    ` : renderCardTemplate('card-' + activeIndex, activeCard)}
  `;
  if (!activeCard.sameAsCardKey) {
    initMoodTagsInto('moodtags-card-' + activeIndex, activeCard, 'card-' + activeIndex);
    renderCardFileLists('card-' + activeIndex, activeCard);
  }
  renderFloatingMediaSummary(4);
}

function selectInstructionGroup(groupIndex) {
  instructionNotice = '';
  state.activeInstructionGroup = groupIndex;
  renderInstructionGroups();
}

function cardHasAnyInput(card) {
  if (!card) return false;
  normalizeCardDetails(card);
  return !!(
    cardHasInstruction(card) ||
    card.staffPhotoAllowed ||
    String(card.personFreeNote || '').trim() ||
    String(card.refNote || '').trim() ||
    (card.personFiles || []).length ||
    (card.refFiles || []).length ||
    (card.assetFiles || []).length
  );
}

function applyInstructionToUnenteredImages() {
  const sourceCard = state.imgCards[state.activeInstructionGroup];
  if (!sourceCard || sourceCard.sameAsCardKey || !hasRequiredInstruction(sourceCard)) {
    window.alert('この画像の必須項目を入力してから適用してください。');
    return;
  }
  const unenteredCards = state.imgCards.filter(card => card !== sourceCard && !cardHasAnyInput(card));
  if (!unenteredCards.length) {
    window.alert('未入力の制作画像はありません。');
    return;
  }
  const sourceKey = getInstructionCardKey(sourceCard);
  const sourceLabel = getInstructionCardLabel(sourceCard);
  if (!window.confirm(`「${sourceLabel}」の指示を、未入力の制作画像${unenteredCards.length}枚に適用しますか？\n入力途中・設定済みの画像は変更されません。`)) return;

  unenteredCards.forEach(card => {
    card.sameAsCardKey = sourceKey;
  });
  saveDraft();
  renderInstructionGroups();
}

function applyInstructionToCurrentTarget() {
  const sourceCard = state.imgCards[state.activeInstructionGroup];
  if (!sourceCard || sourceCard.sameAsCardKey || !hasRequiredInstruction(sourceCard)) {
    window.alert('この画像の必須項目を入力してから適用してください。');
    return;
  }
  const targetId = sourceCard.targetIds?.[0];
  const targetCards = state.imgCards.filter(card => card !== sourceCard && card.targetIds?.[0] === targetId);
  if (!targetCards.length) return;

  const sourceKey = getInstructionCardKey(sourceCard);
  const sourceLabel = getInstructionCardLabel(sourceCard);
  const enteredCount = targetCards.filter(cardHasAnyInput).length;
  const overwriteNote = enteredCount ? `\nうち${enteredCount}枚の入力済み指示は上書きされます。` : '';
  if (!window.confirm(`「${sourceLabel}」の指示を、同じサイズの残り${targetCards.length}枚に適用しますか？${overwriteNote}`)) return;

  targetCards.forEach(card => {
    card.sameAsCardKey = sourceKey;
  });
  saveDraft();
  renderInstructionGroups();
}

function resetCurrentInstructionCard() {
  const activeIndex = state.activeInstructionGroup;
  const currentCard = state.imgCards[activeIndex];
  if (!currentCard) return;

  const currentKey = getInstructionCardKey(currentCard);
  const referencesCurrentCard = (card, visitedKeys = new Set()) => {
    if (!card?.sameAsCardKey || visitedKeys.has(card.sameAsCardKey)) return false;
    if (card.sameAsCardKey === currentKey) return true;
    visitedKeys.add(card.sameAsCardKey);
    return referencesCurrentCard(findInstructionCardByKey(card.sameAsCardKey), visitedKeys);
  };
  const dependentCards = state.imgCards.filter((card, index) =>
    index !== activeIndex && referencesCurrentCard(card)
  );
  const dependentNote = dependentCards.length
    ? `\nこの画像を参照している${dependentCards.length}件の画像は、個別入力に戻ります。`
    : '';
  if (!window.confirm(`この画像の人物設定・制作指示・添付素材・詳細設定をすべてリセットしますか？${dependentNote}`)) return;

  ['personFiles', 'refFiles', 'assetFiles'].forEach(key => {
    (currentCard[key] || []).forEach(file => {
      const previewUrl = filePreviewUrls.get(file);
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        filePreviewUrls.delete(file);
      }
    });
  });
  dependentCards.forEach(card => {
    card.sameAsCardKey = '';
  });
  state.imgCards[activeIndex] = {
    ...makeBlankCard(),
    targetIds: [...(currentCard.targetIds || [])],
    imageNumber: Number(currentCard.imageNumber) || 1
  };
  saveDraft();
  renderInstructionGroups();
}

function resetAllInstructionCards() {
  if (!state.imgCards.length) return;
  if (!window.confirm('すべての画像の人物設定・制作指示・添付素材・詳細設定をリセットしますか？')) return;

  state.imgCards.forEach(card => {
    ['personFiles', 'refFiles', 'assetFiles'].forEach(key => {
      (card[key] || []).forEach(file => {
        const previewUrl = filePreviewUrls.get(file);
        if (previewUrl) {
          URL.revokeObjectURL(previewUrl);
          filePreviewUrls.delete(file);
        }
      });
    });
  });
  state.imgCards = state.imgCards.map(card => ({
    ...makeBlankCard(),
    targetIds: [...(card.targetIds || [])],
    imageNumber: Number(card.imageNumber) || 1
  }));
  state.activeInstructionGroup = 0;
  instructionNotice = 'すべての画像の指示をリセットしました。';
  saveDraft();
  renderInstructionGroups();
}

function selectInstructionTarget(targetId) {
  instructionNotice = '';
  const cardIndex = state.imgCards.findIndex(card => card.targetIds?.[0] === targetId);
  if (cardIndex >= 0) state.activeInstructionGroup = cardIndex;
  closeMobileMediaMenu();
  renderInstructionGroups();
}

function setInstructionReuse(enabled) {
  const activeCard = state.imgCards[state.activeInstructionGroup];
  if (!activeCard) return;
  if (!enabled) {
    activeCard.sameAsCardKey = '';
    instructionNotice = '同じ指示の設定を解除しました。新しい制作指示を入力してください。';
  } else {
    instructionNotice = '';
    const sourceCards = state.imgCards.filter((card, index) =>
      index !== state.activeInstructionGroup &&
      resolveInstructionCard(card) &&
      resolveInstructionCard(card) !== activeCard
    );
    const sourceCard = sourceCards.find(hasRequiredInstruction) || sourceCards[0];
    activeCard.sameAsCardKey = sourceCard ? getInstructionCardKey(sourceCard) : '';
  }
  renderInstructionGroups();
}

function setInstructionReuseSource(cardKey) {
  const activeCard = state.imgCards[state.activeInstructionGroup];
  const sourceCard = findInstructionCardByKey(cardKey);
  if (!activeCard || !sourceCard || sourceCard === activeCard) return;
  activeCard.sameAsCardKey = cardKey;
  renderInstructionGroups();
}

function addInstructionImage() {
  const activeCard = state.imgCards[state.activeInstructionGroup];
  const targetId = activeCard?.targetIds?.[0];
  const target = getInstructionTargets().find(item => item.id === targetId);
  if (!target) return;
  const targetCards = state.imgCards
    .map((card, index) => ({ card, index }))
    .filter(item => item.card.targetIds?.[0] === targetId);
  if (targetCards.length >= target.quantity) return;
  const insertIndex = targetCards[targetCards.length - 1].index + 1;
  state.imgCards.splice(insertIndex, 0, {
    ...makeBlankCard(),
    targetIds: [targetId],
    imageNumber: targetCards.length + 1
  });
  state.activeInstructionGroup = insertIndex;
  renderInstructionGroups();
}

function confirmRemoveInstructionImage(event, cardIndex) {
  event.stopPropagation();
  const card = state.imgCards[cardIndex];
  if (!card || (Number(card.imageNumber) || 1) <= 1) return;
  const confirmed = window.confirm(`${card.imageNumber}枚目の指示を削除しますか？`);
  if (confirmed) removeInstructionImage(cardIndex);
}

function removeInstructionImage(cardIndex) {
  const targetId = state.imgCards[cardIndex]?.targetIds?.[0];
  state.imgCards.splice(cardIndex, 1);
  const targetCards = state.imgCards.filter(card => card.targetIds?.[0] === targetId);
  targetCards.forEach((card, index) => { card.imageNumber = index + 1; });
  const nextIndex = state.imgCards.findIndex(card => card.targetIds?.[0] === targetId);
  state.activeInstructionGroup = nextIndex >= 0
    ? Math.min(nextIndex, state.imgCards.length - 1)
    : Math.min(cardIndex, state.imgCards.length - 1);
  renderInstructionGroups();
}

/* ========== STEP 5: 納期・指名 ========== */
function setDelivery(value) {
  state.delivery = value;
  ['d1', 'd2', 'd3'].forEach(id => document.getElementById('rb-' + id).classList.remove('sel'));
  const targetButtonId = DELIVERY_BUTTON_ID_BY_VALUE[value];
  if (targetButtonId) document.getElementById('rb-' + targetButtonId).classList.add('sel');
  document.getElementById('date-input').style.display = value === '納期指定' ? 'block' : 'none';
  document.getElementById('f-delivery').classList.remove('inv');
}

function syncDes(changed) {
  const ids = ['sel-des1', 'sel-des2', 'sel-des3'];
  const vals = ids.map(id => document.getElementById(id).value);
  ids.forEach((id, i) => {
    const sel = document.getElementById(id);
    const curVal = sel.value;
    const others = vals.filter((_, j) => j !== i && _);
    sel.querySelectorAll('option').forEach(option => { if (option.value) option.disabled = others.includes(option.value); });
    sel.value = curVal;
  });
  state.des1 = document.getElementById('sel-des1').value;
  state.des2 = document.getElementById('sel-des2').value;
  state.des3 = document.getElementById('sel-des3').value;
}

/* ========== UTIL ========== */
function escAttr(s) { return (s || '').replace(/"/g, '&quot;'); }
function escHtml(s) { return (s || '').replace(/</g, '&lt;'); }

/* ========== PREVIEW ========== */
function cardSummary(card, isIndividual) {
  normalizeCardDetails(card);
  const atmosphereTxt = card.moods.filter(mood => ATMOSPHERE_OPTIONS.includes(mood)).join('・') || '—';
  const worldviewTxt = card.moods.filter(mood => WORLDVIEW_OPTIONS.includes(mood)).join('・') || '—';
  const colorTxt = [
    card.baseColor || card.baseColorCode ? `ベース：${card.baseColor || '指定色'}${card.baseColorCode ? `（${card.baseColorCode}）` : ''}` : '',
    card.mainColor || card.mainColorCode ? `メイン：${card.mainColor || '指定色'}${card.mainColorCode ? `（${card.mainColorCode}）` : ''}` : '',
    card.accentColor || card.accentColorCode ? `アクセント：${card.accentColor || '指定色'}${card.accentColorCode ? `（${card.accentColorCode}）` : ''}` : ''
  ].filter(Boolean).join(' / ') || '—';
  const personUsage = card.personUsage || (card.person === '使用しない' ? '使用しない' : (card.person ? '使用する' : ''));
  let assetExtra = '';
  if (card.assetNote || card.assetFiles.length) {
    assetExtra = `<div class="prow"><span class="pk">素材・参考情報</span><span class="pv">${card.assetNote || '—'}</span></div>
      <div class="prow"><span class="pk">添付ファイル</span><span class="pv">${card.assetFiles.length ? card.assetFiles.map(file => file.name).join(', ') : 'なし'}</span></div>`;
  }
  let personExtra = '';
  if (personUsage === '使用する') {
    personExtra = `<div class="prow"><span class="pk">在籍写真の使用</span><span class="pv">${card.staffPhotoAllowed ? '可' : '不可'}</span></div>`;
  }
  return `
    ${isIndividual ? `<div class="prow"><span class="pk">対象画像</span><span class="pv">${card.targetImage || '—'}</span></div>` : ''}
    <div class="prow"><span class="pk">人物写真</span><span class="pv">${personUsage || '—'}</span></div>
    ${personExtra}
    ${assetExtra}
    <div class="prow"><span class="pk">デザイン指示</span><span class="pv">${card.designTxt || '—'}</span></div>
    <div class="prow"><span class="pk">カラー</span><span class="pv">${colorTxt}</span></div>
    <div class="prow"><span class="pk">カラー補足</span><span class="pv">${card.colorNote || '—'}</span></div>
    <div class="prow"><span class="pk">雰囲気</span><span class="pv">${atmosphereTxt}</span></div>
    <div class="prow"><span class="pk">雰囲気・その他</span><span class="pv">${card.atmosphereOther || '—'}</span></div>
    <div class="prow"><span class="pk">世界観・モチーフ</span><span class="pv">${worldviewTxt}</span></div>
    <div class="prow"><span class="pk">世界観・その他</span><span class="pv">${card.worldviewOther || '—'}</span></div>
    <div class="prow"><span class="pk">情報量・装飾</span><span class="pv">${card.infoDensity || '—'}</span></div>`;
}

function buildPreview() {
  const fieldValue = id => { const e = document.getElementById(id); return e ? e.value || '—' : '—'; };

  const mediaDetailHtml = state.selectedMedia.map(mediumName => {
    const sizes = getSelectedSizeEntriesForMedium(mediumName);
    return `<div class="prow"><span class="pk">${escHtml(getMediumDisplayName(mediumName))}</span><span class="pv">${sizes.map(entry => escHtml(formatSizeWithQuantity(entry))).join(' / ') || '—'}</span></div>`;
  }).join('');

  const instructionTargets = getInstructionTargets();
  const individualDesignHtml = state.imgCards
    .filter(card => (card.targetIds || []).length)
    .map(card => {
      const target = instructionTargets.find(item => item.id === card.targetIds?.[0]);
      const targetLabel = target
        ? `${target.displayName}／${target.sizeLabel}${target.quantity > 1 ? `／${card.imageNumber || 1}枚目` : ''}`
        : '';
      const reuseSource = card.sameAsCardKey ? resolveInstructionCard(card) : null;
      return `
        <div class="psec-h" style="margin-top:10px">${escHtml(targetLabel) || '制作画像'}</div>
        ${reuseSource
          ? `<div class="prow"><span class="pk">デザイン指示</span><span class="pv">${escHtml(getInstructionCardLabel(reuseSource, instructionTargets))}と同じ</span></div>`
          : cardSummary(card, false)}`;
    }).join('') || cardSummary(state.common, false);
  const designHtml = individualDesignHtml;

  return `
    <div class="psec">
      <div class="psec-h">依頼者情報</div>
      <div class="prow"><span class="pk">支社名</span><span class="pv">${state.office || '—'}</span></div>
      <div class="prow"><span class="pk">営業担当者</span><span class="pv">${fieldValue('sel-staff') || fieldValue('inp-staff-other') || '—'}</span></div>
      <div class="prow"><span class="pk">フォーム記入者</span><span class="pv">${state.client}</span></div>
      <div class="prow"><span class="pk">メールアドレス</span><span class="pv">${fieldValue('inp-email')}</span></div>
    </div>
    <div class="pdiv"></div>
    <div class="psec">
      <div class="psec-h">画像種別・依頼内容</div>
      <div class="prow"><span class="pk">画像について</span><span class="pv">${['', '新規作成', '修正', '有料案件'][state.imgType] || '—'}</span></div>
      <div class="prow"><span class="pk">請求方法</span><span class="pv">${state.pay}${state.pay === '有料' ? ' (入稿URL: ' + fieldValue('inp-pay-url') + ')' : ''}</span></div>
      <div class="prow"><span class="pk">店舗名</span><span class="pv">${fieldValue('inp-shop')}</span></div>
      <div class="prow"><span class="pk">エリア</span><span class="pv">${fieldValue('inp-area')}</span></div>
      <div class="prow"><span class="pk">掲載URL</span><span class="pv">${state.urlMode === 'なし' ? 'URLなし' : fieldValue('inp-shopurl')}</span></div>
      <div class="prow"><span class="pk">ホームページURL</span><span class="pv">${state.urlMode2 === 'なし' ? 'URLなし' : fieldValue('inp-shopurl2') || '—'}</span></div>
    </div>
    <div class="pdiv"></div>
    <div class="psec">
      <div class="psec-h">業種・媒体・サイズ</div>
      <div class="prow"><span class="pk">業種</span><span class="pv">${state.industry === 'その他' ? state.industryOther || 'その他' : state.industry || '—'}</span></div>
      ${mediaDetailHtml || '<div class="prow"><span class="pk">媒体</span><span class="pv">—</span></div>'}
      <div class="prow"><span class="pk">媒体・サイズ（自動まとめ）</span><span class="pv">${fieldValue('inp-imgsize')}</span></div>
      <div class="prow"><span class="pk">画像総枚数</span><span class="pv">${fieldValue('inp-count')}枚</span></div>
    </div>
    <div class="pdiv"></div>
    <div class="psec">
      <div class="psec-h">デザイン指示</div>
      ${designHtml}
    </div>
    <div class="pdiv"></div>
    <div class="psec">
      <div class="psec-h">納期・指名</div>
      <div class="prow"><span class="pk">納期希望</span><span class="pv">${state.delivery || '—'}${state.delivery === '納期指定' ? ' (' + fieldValue('inp-date') + ')' : ''}</span></div>
      <div class="prow"><span class="pk">デザイナー</span><span class="pv">${[state.des1, state.des2, state.des3].filter(Boolean).join(' / ') || '指名なし'}</span></div>
    </div>`;
}

/* ========== VALIDATION ========== */
function validateCard(prefix, card, validationRef, isIndividual) {
  const reqField = (fieldId, isValid) => {
    const fieldEl = document.getElementById(fieldId);
    if (!fieldEl) return;
    if (!isValid()) { fieldEl.classList.add('inv'); validationRef.ok = false; }
    else fieldEl.classList.remove('inv');
  };
  // 個別モードでは対象画像の入力も必須
  if (isIndividual) {
    const targetEl = document.querySelector(`#imgcard-${prefix.replace('card-', '')} .field:first-of-type`);
    if (!card.targetImage.trim()) {
      if (targetEl) targetEl.classList.add('inv');
      validationRef.ok = false;
    } else {
      if (targetEl) targetEl.classList.remove('inv');
    }
  }
  reqField(`f-person-${prefix}`, () => {
    const usage = card.personUsage || (card.person === '使用しない' ? '使用しない' : (card.person ? '使用する' : ''));
    return usage === '使用する' || usage === '使用しない';
  });
  reqField(`f-designtxt-${prefix}`, () => hasDesignInstructionContent(card.designTxt));
}

function validate(step) {
  let ok = true;
  const req = (fieldId, isValid) => {
    const fieldEl = document.getElementById(fieldId);
    if (!fieldEl) return;
    if (!isValid()) { fieldEl.classList.add('inv'); ok = false; }
    else fieldEl.classList.remove('inv');
  };

  if (step === 1) {
    req('f-office', () => document.getElementById('sel-office').value);
    const officeValue = document.getElementById('sel-office').value;
    if (officeValue === 'VOTEC' || officeValue === 'その他')
      req('f-staff', () => document.getElementById('inp-staff-other').value.trim());
    else
      req('f-staff', () => document.getElementById('sel-staff').value);
    if (state.client === '代理')
      req('f-agent', () => document.getElementById('inp-agent').value.trim());
    req('f-email', () => {
      const emailValue = document.getElementById('inp-email').value;
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue) ? emailValue : '';
    });
  }
  if (step === 2) {
    req('f-imgtype', () => state.imgType ? 'ok' : '');
    if (state.pay === '有料')
      req('f-pay-url', () => document.getElementById('inp-pay-url').value.trim());
    req('f-shop',    () => document.getElementById('inp-shop').value.trim());
    req('f-area',    () => document.getElementById('inp-area').value.trim());
    if (state.urlMode === 'あり')
      req('f-shopurl', () => document.getElementById('inp-shopurl').value.trim());
  }
  if (step === 3) {
    req('f-industry', () => state.industry);
    if (state.industry === 'その他')
      req('f-industry-other', () => document.getElementById('inp-industry-other').value.trim());
    req('f-medium',   () => state.selectedMedia.length ? 'ok' : '');
    if (state.selectedMedia.includes('その他'))
      req('f-medium-other', () => document.getElementById('inp-medium-other').value.trim());
    state.selectedMedia.forEach(mediumName => {
      req(`f-size-${cssId(mediumName)}`, () => hasMediumSize(mediumName) ? 'ok' : '');
    });
  }
  if (step === 4) {
    const validationRef = { ok: true };
    const instructionTargets = getInstructionTargets();
    const missingTarget = instructionTargets.find(target =>
      state.imgCards.filter(card => card.targetIds?.[0] === target.id).length < target.quantity
    );
    if (missingTarget) {
      selectInstructionTarget(missingTarget.id);
      ok = false;
    }
    const imageCards = state.imgCards
      .map((card, index) => ({ card, index }))
      .filter(item => (item.card.targetIds || []).length);
    const invalidGroup = imageCards.find(({ card }) => !hasRequiredInstruction(card));
    if (invalidGroup) {
      state.activeInstructionGroup = invalidGroup.index;
      renderInstructionGroups();
      if (invalidGroup.card.sameAsCardKey) {
        validationRef.ok = false;
      } else {
        validateCard('card-' + invalidGroup.index, invalidGroup.card, validationRef, false);
      }
    }
    ok = ok && validationRef.ok;
  }
  if (step === 5) {
    req('f-delivery', () => state.delivery);
    if (state.delivery === '納期指定') {
      if (!document.getElementById('inp-date').value) {
        document.getElementById('f-delivery').classList.add('inv');
        ok = false;
      }
    }
  }
  return ok;
}

function scrollToFirstError() {
  const activePanel = document.querySelector('.panel.on');
  if (!activePanel) return;

  const errorField = activePanel.querySelector('.inv');
  if (!errorField) return;

  errorField.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const focusable = errorField.querySelector('input:not([type="hidden"]), select, textarea, button, .rbtn, .rcard');
  if (focusable && typeof focusable.focus === 'function') {
    setTimeout(() => focusable.focus({ preventScroll: true }), 250);
  }
}

/* ========== NAVIGATION ========== */
function goTo(step) {
  closeMobileMediaMenu();
  if (step <= totalSteps) maxVisitedStep = Math.max(maxVisitedStep, step);
  document.querySelectorAll('.panel').forEach(panel => panel.classList.remove('on'));
  const activePanel = document.getElementById(step <= totalSteps ? 'p' + step : 'p-success');
  activePanel.classList.add('on');

  const noticeStack = document.querySelector('.notice-stack');
  if (noticeStack) noticeStack.style.display = step === 1 ? 'grid' : 'none';

  for (let i = 1; i <= totalSteps; i++) {
    const dotEl = document.getElementById('d' + i);
    const labelEl = document.getElementById('l' + i);
    const itemEl = dotEl.closest('.sc-item');
    const canNavigate = i !== step && i <= maxVisitedStep;
    dotEl.className = 'sc-dot' + (i < step ? ' done' : i === step ? ' on' : '');
    dotEl.innerHTML = i < step ? '<i class="ti ti-check"></i>' : String(i);
    labelEl.className = 'sc-lbl' + (i === step ? ' on' : '');
    itemEl.classList.toggle('is-clickable', canNavigate);
    itemEl.onclick = canNavigate ? () => jumpToStep(i) : null;
    itemEl.onkeydown = canNavigate
      ? event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            jumpToStep(i);
          }
        }
      : null;
    if (canNavigate) {
      itemEl.setAttribute('role', 'button');
      itemEl.setAttribute('tabindex', '0');
      itemEl.setAttribute('aria-label', `${labelEl.textContent}へ移動`);
    } else {
      itemEl.removeAttribute('role');
      itemEl.removeAttribute('tabindex');
      itemEl.removeAttribute('aria-label');
    }
    if (i < totalSteps) {
      const lineEl = document.getElementById('ln' + i);
      if (lineEl) lineEl.className = 'sc-line' + (i < step ? ' done' : '');
    }
  }

  document.getElementById('prog').style.width = (step / totalSteps * 100) + '%';
  document.getElementById('btn-back').style.display = step > 1 ? 'inline-flex' : 'none';

  const nextBtn = document.getElementById('btn-next');
  nextBtn.innerHTML = step === totalSteps
    ? '送信する <i class="ti ti-send"></i>'
    : '次へ <i class="ti ti-arrow-right"></i>';

  const currentTitleEl = activePanel.querySelector('.ptitle');
  const stepTitle = step <= totalSteps && currentTitleEl ? currentTitleEl.textContent : '完了';
  document.getElementById('header-step-value').textContent = `${Math.min(step, totalSteps)} / ${totalSteps} ・ ${stepTitle}`;

  if (step > totalSteps) document.getElementById('nav-bar').style.display = 'none';
  renderFloatingMediaSummary(step);

  requestAnimationFrame(() => activePanel.scrollIntoView({ behavior: 'auto', block: 'start' }));
}

function jumpToStep(step) {
  if (step < 1 || step > maxVisitedStep || step === currentStep) return;
  currentStep = step;
  if (currentStep === 4) syncInstructionGroups();
  if (currentStep === totalSteps) {
    document.getElementById('preview-content').innerHTML = buildPreview();
  }
  goTo(currentStep);
}

function nextStep() {
  if (currentStep === 4) {
    const bulkPanel = document.querySelector('.bulk-instruction-panel');
    if (bulkPanel?.open && !applyBulkInstructions({ automatic: true })) {
      document.getElementById('bulk-instruction-input')?.focus();
      return;
    }
  }
  if (!TEST_MODE_ALLOW_INCOMPLETE_NAVIGATION && !validate(currentStep)) {
    scrollToFirstError();
    return;
  }
  if (currentStep === totalSteps) { submit(); return; }
  currentStep++;
  if (currentStep === 4) {
    syncInstructionGroups();
  }
  if (currentStep === totalSteps) {
    document.getElementById('preview-content').innerHTML = buildPreview();
  }
  goTo(currentStep);
}

function prevStep() {
  if (currentStep > 1) { currentStep--; goTo(currentStep); }
}

function submit() {
  goTo(totalSteps + 1);
  document.getElementById('req-id').textContent = 'BNR-' + Date.now().toString(36).toUpperCase();
}

/* ========== DRAFT AUTOSAVE ========== */
function getPersistableState() {
  return JSON.parse(JSON.stringify(state, (key, value) => {
    if (key === 'files' || key === 'personFiles' || key === 'refFiles' ||
        key === 'assetFiles' || key === 'bulkAssetFiles') return [];
    return value;
  }));
}

function collectDraftControls() {
  const controls = {};
  document.querySelectorAll('input[id], select[id], textarea[id]').forEach(control => {
    if (control.type === 'file' || control.type === 'hidden') return;
    controls[control.id] = control.type === 'checkbox' || control.type === 'radio'
      ? { checked: control.checked }
      : { value: control.value };
  });
  return controls;
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({
      state: getPersistableState(),
      controls: collectDraftControls(),
      currentStep: Math.min(Math.max(currentStep, 1), totalSteps),
      maxVisitedStep: Math.min(Math.max(maxVisitedStep, currentStep), totalSteps),
      savedAt: Date.now()
    }));
  } catch (error) {
    console.warn('入力内容を保存できませんでした。', error);
  }
}

function readDraft() {
  try {
    const rawDraft = localStorage.getItem(DRAFT_STORAGE_KEY);
    return rawDraft ? JSON.parse(rawDraft) : null;
  } catch (error) {
    console.warn('保存済みの入力内容を読み込めませんでした。', error);
    return null;
  }
}

function hydrateDraftState(savedState) {
  if (!savedState || typeof savedState !== 'object') return;
  state = { ...state, ...savedState };
  state.selectedMedia = Array.isArray(savedState.selectedMedia) ? savedState.selectedMedia : [];
  state.openMedia = Array.isArray(savedState.openMedia) ? savedState.openMedia : [];
  state.mediaState = savedState.mediaState && typeof savedState.mediaState === 'object'
    ? savedState.mediaState
    : {};
  state.bulkAssetFiles = [];
  state.common = normalizeCardDetails({
    ...makeBlankCard(),
    ...(savedState.common || {}),
    personFiles: [],
    refFiles: [],
    assetFiles: []
  });
  state.imgCards = Array.isArray(savedState.imgCards)
    ? savedState.imgCards.map(card => normalizeCardDetails({
        ...makeBlankCard(),
        ...card,
        personFiles: [],
        refFiles: [],
        assetFiles: []
      }))
    : [];
  state.files = [];
}

function applyDraftControls(controls) {
  if (!controls || typeof controls !== 'object') return;
  Object.entries(controls).forEach(([id, savedControl]) => {
    const control = document.getElementById(id);
    if (!control || control.type === 'file') return;
    if (control.type === 'checkbox' || control.type === 'radio') {
      control.checked = !!savedControl.checked;
    } else if ('value' in savedControl) {
      control.value = savedControl.value;
    }
  });
}

function restoreDraftUI(draft) {
  const controls = draft && draft.controls ? draft.controls : {};

  const officeSelect = document.getElementById('sel-office');
  officeSelect.value = controls['sel-office']?.value || state.office || '';
  if (officeSelect.value) onOffice();

  setClient(state.client || '本人');
  if (state.imgType) setImgType(state.imgType);
  setUrlMode(1, state.urlMode === 'なし');
  setUrlMode(2, state.urlMode2 === 'なし');

  document.querySelectorAll('#industry-btns .rbtn').forEach(button => {
    button.classList.toggle('sel', button.textContent.trim() === state.industry);
  });
  document.querySelectorAll('.fuzoku-warn').forEach(warning => {
    warning.style.display = state.industry === '風俗' ? 'flex' : 'none';
  });
  document.getElementById('f-industry-other').style.display = state.industry === 'その他' ? 'block' : 'none';
  renderMediumChips(state.industry);
  renderMediumBlocks();
  document.getElementById('f-medium-other').style.display =
    state.selectedMedia.includes('その他') ? 'block' : 'none';

  renderCommonBlock();
  autoFillImgSize();
  syncInstructionGroups();
  if (state.delivery) setDelivery(state.delivery);

  applyDraftControls(controls);
  const bulkInstructionInput = document.getElementById('bulk-instruction-input');
  if (bulkInstructionInput) bulkInstructionInput.value = state.bulkInstruction || '';
  renderBulkAssetFiles();
  state.industryOther = document.getElementById('inp-industry-other').value;
  state.mediumOther = document.getElementById('inp-medium-other').value;
  state.deliveryDate = document.getElementById('inp-date').value;
  state.des1 = document.getElementById('sel-des1').value;
  state.des2 = document.getElementById('sel-des2').value;
  state.des3 = document.getElementById('sel-des3').value;
  syncDes();

  currentStep = Math.min(Math.max(Number(draft.currentStep) || 1, 1), totalSteps);
  maxVisitedStep = Math.min(Math.max(Number(draft.maxVisitedStep) || currentStep, currentStep), totalSteps);
  if (currentStep === totalSteps) {
    document.getElementById('preview-content').innerHTML = buildPreview();
  }
  goTo(currentStep);
}

function initDraftAutosave() {
  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 120);
  };
  document.addEventListener('input', scheduleSave);
  document.addEventListener('change', scheduleSave);
  document.addEventListener('click', scheduleSave);
  window.addEventListener('beforeunload', saveDraft);
}

/* ========== INIT ========== */
function initDesigners() {
  ['sel-des1', 'sel-des2', 'sel-des3'].forEach(id => {
    const select = document.getElementById(id);
    select.innerHTML = '<option value="">選択しない</option>' +
      Object.entries(designerGroups).map(([areaName, designers]) => `
        <optgroup label="${areaName}">
          ${designers.map(designerName => `<option value="${designerName}">${designerName}</option>`).join('')}
        </optgroup>
      `).join('');
  });
}

const restoredDraft = readDraft();
if (restoredDraft) hydrateDraftState(restoredDraft.state);
initCongestion();
initNotices();
initDesigners();
renderCommonBlock();
if (restoredDraft) {
  restoreDraftUI(restoredDraft);
} else {
  goTo(currentStep);
}
initDraftAutosave();
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeMobileMediaMenu();
});
window.addEventListener('resize', () => {
  if (window.innerWidth > 600) closeMobileMediaMenu();
});
