// Translate authored report copy, keeping test names, paths and logs as evidence.
(function () {
  const control = document.getElementById('lang');
  if (!control) return;
  const key = 'agentdeck-design-locale';
  const protectedCopy = 'script,style,code,pre,.tname,.fpath,.cmd,.skipped tbody td:first-child';
  const nodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement.closest(protectedCopy) && node.nodeValue.trim()) {
      nodes.push({ node, original: node.nodeValue });
    }
  }
  const attributes = [];
  document.querySelectorAll('[aria-label],[title]').forEach((node) => {
    if (node.closest(protectedCopy)) return;
    ['aria-label', 'title'].forEach((name) => {
      if (node.hasAttribute(name)) attributes.push({ node, name, original: node.getAttribute(name) });
    });
  });
  const patterns = [
    [/^(\d[\d,]*) tests executed$/, '$1개 테스트 실행'],
    [/^([\d.]+)% of executed$/, '실행한 테스트의 $1%'],
    [/^(\d[\d,]*) (?:test )?files?$/, '$1개 파일'],
    [/^(\d[\d,]*) suites?$/, '$1개 테스트 모음'],
    [/^(\d[\d,]*) failing$/, '$1개 실패'],
    [/^(\d[\d,]*) of (\d[\d,]*) passed$/, '$2개 중 $1개 통과'],
    [/^last (\d+) runs on master$/, 'master 최근 $1회 실행'],
    [/^floor ([\d.]+)% · above$/, '기준 $1% · 충족'],
    [/^floor ([\d.]+)% · BELOW$/, '기준 $1% · 미달'],
    [/^floor ([\d.]+)%$/, '기준 $1%'],
    [/^(\d+) source files, least covered first$/, '소스 파일 $1개 · 커버리지 낮은 순'],
    [/^(\d[\d,]*) \/ (\d[\d,]*) lines · (\d[\d,]*) files?$/, '$1 / $2줄 · 파일 $3개'],
    [
      /^(\d+) cases? skipped here: (\d+) run on another CI runner, (\d+) on no CI runner$/,
      '여기서 건너뛴 테스트 $1개: 다른 CI에서 $2개 실행, CI 미실행 $3개',
    ],
    [/^Merge policy · checked (.*)$/, '병합 정책 · 확인일 $1'],
    [/^Latest hosted run passed ·$/, '최근 CI 실행 통과 ·'],
    [/^Latest hosted run failed ·$/, '최근 CI 실행 실패 ·'],
    [/^· this commit · (.*)$/, '· 이 커밋 · $1'],
    [/^(.*\.yml) runs$/, '$1 실행 기록'],
    [
      /^JUnit \+ Robolectric on the JVM \(ubuntu\), (\d+) suites?\.$/,
      'JVM(ubuntu)에서 JUnit + Robolectric · 테스트 모음 $1개.',
    ],
    [
      /^(Pass|Fail|Not run|Partial verification) · ([\d,]+) tests(.*) · generated (.*)$/,
      function (_, result, count, commit, date) {
        return REPORT_KO[result] + ' · 테스트 ' + count + '개' + commit.replace('commit', '커밋') + ' · 생성 ' + date;
      },
    ],
    [/^Example cases: (\d+) passed, (\d+) failed, (\d+) skipped\.$/, '이번 실행 예시 결과: $1 통과, $2 실패, $3 건너뜀.'],
    [/^(\d+) partially executed$/, '$1개 부분 실행'],
    [/^(\d+) passed$/, '$1개 통과'],
    [/^(\d+) failed$/, '$1개 실패'],
    [/^(\d+) not found in this run$/, '이번 실행에서 $1개 찾지 못함'],
    [/^(\d+) not executed here$/, '여기서 $1개 미실행'],
  ];
  function translate(original, locale) {
    if (locale !== 'ko') return original;
    const text = original.trim();
    let translated = REPORT_KO[text];
    if (!translated) {
      for (const [pattern, replacement] of patterns) {
        if (pattern.test(text)) {
          translated = text.replace(pattern, replacement);
          break;
        }
      }
    }
    // Composite catalog metadata, scenario summaries and screen-reader counts.
    if (!translated) {
      // Split the outer separator first so known phrases containing commas
      // still match whole dictionary entries in the recursive call.
      const separator = [' · ', ' — ', '. ', ': ', ', '].find((value) => text.includes(value));
      if (separator) {
        translated = text.split(separator).map((part) => translate(part, locale)).join(separator);
        if (translated === text) translated = null;
      }
    }
    return translated ? original.replace(text, translated) : original;
  }
  function apply(locale) {
    locale = ['en', 'ko', 'ja'].includes(locale) ? locale : 'en';
    control.value = locale;
    // Japanese falls back to canonical English until a report translation exists.
    document.documentElement.lang = locale === 'ko' ? 'ko' : 'en';
    nodes.forEach(({ node, original }) => {
      node.nodeValue = translate(original, locale);
    });
    attributes.forEach(({ node, name, original }) => {
      node.setAttribute(name, translate(original, locale));
    });
    document.title = locale === 'ko' ? 'AgentDeck — 테스트 리포트' : 'AgentDeck — Test Report';
  }
  let saved = 'en';
  try {
    saved = localStorage.getItem(key) || 'en';
  } catch {
    /* Storage can be disabled. */
  }
  apply(saved);
  control.addEventListener('change', () => {
    apply(control.value);
    try {
      localStorage.setItem(key, control.value);
    } catch {
      /* Translation still works. */
    }
  });
})();
