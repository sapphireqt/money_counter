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

// Step 3 --------------------------------------------------------------------

test("review header, summary line and button use the approved copy", () => {
  assert.match(component, /Проверьте операции перед импортом/);
  assert.match(component, /Будут созданы \{summaryCount\}/);
  // The primary button reads "Импортировать" with no count appended.
  assert.match(component, /step === 3 \? "Импортировать" : "Далее"/);
  assert.match(component, /Сначала решите все вопросы по операциям/);
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

// Full list -----------------------------------------------------------------

test("full list has search, filters, status column and count", () => {
  assert.match(component, /Открыть полный список/);
  assert.match(component, /Все операции к импорту · \{totalOps\}/);
  assert.match(component, /placeholder="Поиск по описанию"/);
  assert.match(component, /<option value="attention">Требуют внимания<\/option>/);
  assert.match(component, /Показано \{fullRows\.length\} из \{totalOps\}/);
  assert.match(component, /Требует проверки/);
});

// Behaviour invariants ------------------------------------------------------

test("final import posts only included rows with skipDedupe", () => {
  assert.match(component, /skipDedupe: true/);
  assert.match(component, /ops\.filter\(\(op\) => !isExcluded\(op\)\)/);
  assert.match(component, /const nextDisabled =/);
  assert.match(component, /unresolvedCount > 0/);
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
