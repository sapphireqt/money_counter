import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../app/money-counter.tsx", import.meta.url),
  "utf8"
);
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

// Entry point + modal shell -------------------------------------------------

test("entry point and modal shell copy match the approved Phase 2 strings", () => {
  assert.match(component, /Импортировать операции/); // + Добавить menu item
  assert.match(component, /<h2>Импорт выписки<\/h2>/);
  assert.match(component, /<ImportModal/);
  assert.match(component, /\{importOpen \? \(/); // marker the Phase 1 contract slices on
});

test("stepper has the three approved steps with active/done states", () => {
  assert.match(component, /<strong>Файл и счёт<\/strong>/);
  assert.match(component, /<strong>Сопоставление<\/strong>/);
  assert.match(component, /<strong>Проверка<\/strong>/);
  assert.match(component, /step === index \? " active" : ""/);
  assert.match(component, /step > index \? " done" : ""/);
});

// Step 1 --------------------------------------------------------------------

test("step 1 dropzone uses the approved copy and formats line", () => {
  assert.match(component, /Перетащите сюда банковскую выписку/);
  assert.match(component, /или выберите файл на компьютере/);
  assert.match(component, /PDF, CSV, TSV · до 20 МБ/);
  assert.match(component, /Один файл выписки импортируется в один счёт/);
  assert.match(component, /Импортировать в счёт/);
  assert.match(component, /Все найденные операции будут созданы в выбранном счёте/);
  assert.match(component, /✓ Валюта счёта совпадает с валютой выписки/);
});

test("step 1 has the four compact interim states with exact copy", () => {
  assert.match(component, /Читаем выписку…/);
  assert.match(component, /Не удалось прочитать файл/);
  assert.match(component, /Попробуйте выбрать другой файл\./);
  assert.match(component, /В выписке не найдено операций/);
  assert.match(component, /Валюта выписки — \{fileCurrency\}, счёта — \{account\.currency\}\./);
});

// Step 2 --------------------------------------------------------------------

test("step 2 mapping intro and the KBank PDF sources are present", () => {
  assert.match(component, /Проверьте сопоставление/);
  assert.match(component, /Так данные из файла будут записаны в операции/);
  assert.match(component, /source="Descriptions, Details"/);
  assert.match(component, /source="Withdrawal \/ Deposit"/);
  assert.match(component, /Выберите колонку файла/);
});

test("fee note is rendered only when a fee is found", () => {
  assert.match(component, /summary\.feeCount > 0 \?/);
  assert.match(component, /Найдена 1 комиссия на сумму/);
  assert.match(component, /импортирована как отдельный расход/);
});

test("the recognized-types subline is computed from normalized ops for all formats", () => {
  // Single source of truth, built from summarizeOperations (works for PDF too).
  assert.match(component, /const typeStatsLine = `Распознано: \$\{summary\.expenseCount\}/);
  // Passed to BOTH the static PDF «Withdrawal / Deposit» row and the editable
  // TSV amount row — so the subline shows for every format.
  assert.match(
    component,
    /source="Withdrawal \/ Deposit"[\s\S]*?subline=\{typeStatsLine\}/
  );
  // Exactly two mapping rows carry the subline (PDF static + TSV editable).
  assert.equal((component.match(/subline=\{typeStatsLine\}/g) ?? []).length, 2);
});

// Step 3 --------------------------------------------------------------------

test("review header, summary line and button use the approved copy", () => {
  assert.match(component, /Проверьте операции перед импортом/);
  assert.match(component, /Будут созданы \$\{summaryCount\}/);
  // A non-breaking space keeps «счёте» attached to the account name inline.
  assert.match(component, /в счёте\\u00A0`\}/);
  // The primary button reads "Импортировать" with no count appended.
  assert.match(component, /allExcluded \? "Завершить" : "Импортировать"/);
  assert.match(component, /Сначала решите все вопросы по операциям/);
});

test("all-excluded review shows the finish state without a create call", () => {
  assert.match(component, /Все операции исключены\. Новые операции созданы не будут\./);
  assert.match(component, /const allExcluded =/);
  assert.match(component, /includedCount === 0/);
  // «Завершить» just closes the modal — goNext calls onClose(), not handleImport.
  assert.match(component, /else if \(allExcluded\) onClose\(\);/);
});

test("problem-row reasons and resolved states match the approved copy", () => {
  assert.match(component, /Похожая операция уже есть в выбранном счёте\./);
  assert.match(component, /Не удалось определить дату операции\./);
  assert.match(component, /Сумма не совпадает с изменением баланса\./);
  assert.match(component, /Банк отметил операцию как \$\{issue\.state\}\./);
  assert.match(component, /Будет импортирована несмотря на возможное совпадение\./);
  assert.match(component, /Исключена из импорта\./);
  assert.match(component, /Дата выбрана: \$\{dmy\(decision\.value\)\}\./);
  assert.match(component, /decision \? "Решено" : "Проверить"/);
});

// Footer: file pill / full-list link ---------------------------------------

test("footer shows «Файл: {filename}» on steps 1–2 and hides it on step 3", () => {
  // Steps 1–2: muted «Файл:» label + the name in normal text (v34.1 pill).
  assert.match(component, /<div className="im-file-pill">\s*Файл: <strong>\{fileName\}<\/strong>/);
  // Step 3 renders the full-list link (or nothing) — never the file pill.
  assert.match(
    component,
    /\{step === 3 \?\s*\(\s*totalOps > 25 \?[\s\S]*?\) : fileName && status === "ready" \?/
  );
});

test("full-list link appears only when total > 25 on step 3", () => {
  assert.match(component, /step === 3 \?\s*\(\s*totalOps > 25 \?/);
  assert.match(css, /\.im-file-pill\s*\{[^}]*color:\s*var\(--muted\)/);
  assert.match(css, /\.im-file-pill strong\s*\{[^}]*color:\s*var\(--text\)/);
});

// Full list -----------------------------------------------------------------

test("full list has search, filters, status column and count", () => {
  assert.match(component, /Открыть полный список/);
  assert.match(component, /Все операции к импорту · \{totalOps\}/);
  assert.match(component, /placeholder="Поиск по описанию"/);
  assert.match(component, /<option value="attention">Требуют внимания<\/option>/);
  assert.match(component, /Показано \{fullRows\.length\} из \{totalOps\}/);
  assert.match(component, /Требует проверки/);
});

test("review and full list share one attention-ordering helper", () => {
  // Full list: filter/search first, then orderByAttention.
  assert.match(component, /const fullRows = orderByAttention\(\s*ops\.filter/);
  // Compact review uses the same helper.
  assert.match(component, /orderByAttention\(ops, hasIssues\)/);
  // The «Требуют внимания» filter keeps only unresolved rows.
  assert.match(component, /fullFilter === "attention"\) return isUnresolved\(op\)/);
});

// Behaviour invariants ------------------------------------------------------

test("final import posts only included rows with skipDedupe", () => {
  // skipDedupe is opt-in per submit — true when the duplicate search succeeded,
  // false as a safety net when it failed (so nothing is created unchecked).
  assert.match(component, /skipDedupe: !dupFailed/);
  assert.match(component, /ops\.filter\(\(op\) => !isExcluded\(op\)\)/);
  assert.match(component, /const nextDisabled =/);
  assert.match(component, /unresolvedCount > 0/);
  // Import waits for the duplicate search to finish before it is enabled.
  assert.match(component, /duplicateSearchPending/);
});

test("duplicate search reads existing operations without writing", () => {
  assert.match(component, /\/api\/transactions\?accountId=\$\{accountId\}&from=\$\{from\}&to=\$\{to\}/);
  assert.match(component, /attachDuplicateCandidates\(rawOps, existing\)/);
});

// CSS invariants ------------------------------------------------------------

test("modal geometry matches v34.1 and review is single-scroll", () => {
  assert.match(css, /\.im-dialog\s*\{[^}]*width:\s*min\(660px/);
  assert.match(css, /\.im-dialog\.review-fixed\s*\{[^}]*height:\s*min\(760px/);
  // Only the operations list scrolls inside the fixed-height review.
  assert.match(css, /\.im-dialog\.review-fixed \.im-review-rows\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /\.im-dialog\.review-fixed \.im-body\s*\{[^}]*overflow:\s*hidden/);
  // Full-list header stays sticky.
  assert.match(css, /\.im-full-head\s*\{[^}]*position:\s*sticky/);
});
