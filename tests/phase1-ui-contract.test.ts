import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../app/money-counter.tsx", import.meta.url),
  "utf8"
);
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

function between(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
}

test("operation and transfer forms contain no import controls", () => {
  const forms = between(component, "{formOpen ? (", "{importOpen ? (");
  assert.doesNotMatch(forms, /Импорт выписки|type="file"|handleImport|importAnalysis/);
});

test("Phase 1 geometry is driven by the approved shared tokens", () => {
  assert.match(css, /--sidebar-w:\s*72px/);
  assert.match(css, /--left-col:\s*922px/);
  assert.match(css, /--right-col:\s*350px/);
  assert.match(css, /--content-gap:\s*18px/);
  assert.match(css, /--content-max:\s*1346px/);
  assert.match(css, /\.operationsSurface\s*\{[^}]*width:\s*var\(--left-col\)/);
  assert.match(css, /\.operationsSurface \.p1TableFrame\s*\{[^}]*width:\s*var\(--left-col\)/);
});

test("operations toolbar includes the prototype period/history scope", () => {
  assert.match(component, /className="operationScope"/);
  assert.match(component, /aria-label="Область поиска и фильтрации"/);
  assert.match(component, /<option value="period">Текущий период<\/option>/);
  assert.match(component, /<option value="history">Вся история<\/option>/);
  assert.match(css, /\.operationScope\s*\{/);
  assert.match(css, /grid-template-columns:\s*auto minmax\(190px, 1fr\) auto/);
});

test("table header and right rail use viewport sticky containers", () => {
  assert.match(
    css,
    /\.p1Layout\s*\{[^}]*align-items:\s*stretch/
  );
  assert.match(
    css,
    /\.p1OpsTable thead\s*\{[^}]*position:\s*sticky[^}]*top:\s*74px/
  );
  assert.match(
    css,
    /\.p1OpsTable\.compactHeader thead\s*\{[^}]*top:\s*132px/
  );
  assert.match(
    css,
    /\.rightStickyStack\s*\{[^}]*position:\s*sticky[^}]*top:\s*10px/
  );
  assert.doesNotMatch(component, /rightStackSticky|stickyDisabled|setRightStackSticky/);
});

test("history date mode uses year groups and a per-row date column", () => {
  assert.match(component, /const historyDateMode = historyScopeActive && operationSort === "date"/);
  assert.match(component, /<tr className="yearGroup">/);
  assert.match(component, /groupOperationItemsByYear/);
  assert.match(component, /historyDateMode \? <th>Дата<\/th>/);
  assert.match(component, /group\.items\.map\(\(row\) => renderOperationRow\(row, true\)\)/);
  assert.match(css, /\.p1OpsTable\.historyMode tr\s*\{/);
  assert.match(css, /\.p1OpsTable \.yearGroup > td\s*\{[^}]*font-size:\s*16px[^}]*font-weight:\s*800/);
});

test("forecast-off summary uses the full content column", () => {
  assert.match(
    css,
    /\.phase1Top \.p1SummaryGrid:not\(\.withForecast\)\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/
  );
  assert.match(
    component,
    /className=\{`p1SummaryGrid \$\{forecastVisible \? "withForecast" : ""\}/
  );
});

test("sticky metrics use the prototype header-context composition", () => {
  assert.match(
    css,
    /\.compactMetrics\s*\{[^}]*gap:\s*0[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto[^}]*padding:\s*0 28px/
  );
  assert.match(
    css,
    /\.compactFact\s*\{[^}]*align-items:\s*baseline[^}]*display:\s*flex[^}]*gap:\s*5px[^}]*padding:\s*0 11px/
  );
  assert.match(
    css,
    /\.compactForecast\s*\{[^}]*background:\s*transparent[^}]*border-left:\s*1px solid #cbdccc[^}]*display:\s*flex[^}]*padding:\s*0 0 0 13px/
  );
});

test("account card keeps the accepted typography and tonal states", () => {
  assert.match(
    css,
    /\.accountPanelName strong\s*\{[^}]*color:\s*#555560[^}]*font-size:\s*14px[^}]*font-weight:\s*400/
  );
  assert.match(
    css,
    /\.accountPanelSpend\s*\{[^}]*color:\s*#666671[^}]*font-size:\s*14px[^}]*font-weight:\s*400/
  );
  assert.match(
    css,
    /\.accountPanelBalance\s*\{[^}]*color:\s*#222229[^}]*font-size:\s*14px[^}]*font-weight:\s*700/
  );
  assert.match(
    css,
    /\.accountPanelBalance small\s*\{[^}]*color:\s*#7b7b86[^}]*font-size:\s*12px[^}]*font-weight:\s*400/
  );
  assert.match(css, /\.accountPanelBalance\.negative,[^{]*\{[^}]*color:\s*#d55353/);
  assert.match(css, /\.accountPanelBalance\.zero,[^{]*\{[^}]*color:\s*#aaaaaa/);
  assert.match(css, /\.accountPanelTotal strong\s*\{[^}]*font-weight:\s*800/);

  const accountName = between(
    component,
    '<span className="accountPanelName"',
    '<span className="accountPanelSpend"'
  );
  assert.match(accountName, /\{account\.name\}/);
  assert.doesNotMatch(accountName, /account\.currency/);
});

test("account overflow state is session-scoped and capped at nine", () => {
  assert.match(component, /sessionStorage\.getItem\("mc\.accountsExpanded"\)/);
  assert.match(component, /sessionStorage\.setItem\("mc\.accountsExpanded"/);
  assert.match(component, /selectAccountPanelItems\(panelAccounts, accountsExpanded, viewedOverflowAccountIds\)/);
  assert.match(component, /panelAccounts\.length > 9/);
  assert.match(component, /accountsExpanded \? "Свернуть" : "Показать ещё"/);
});

test("all account pickers use the active-on-date selector", () => {
  assert.match(
    component,
    /selectActiveAccountsOn\(accounts, transactionForm\.date \|\| today\(\)\)/
  );
  assert.match(
    component,
    /selectActiveAccountsOn\(accounts, partnerCreate\.date \|\| today\(\)\)/
  );
  assert.match(component, /Этот счёт недоступен на выбранную дату\. Выберите другой счёт\./);
});

test("transfer UI exposes every required amount and linking mode", () => {
  assert.match(component, /transferCrossCurrency \? \(/);
  assert.match(component, /htmlFor="transfer-amount-out">Списано/);
  assert.match(component, /htmlFor="transfer-amount-in">Зачислено/);
  assert.match(component, /htmlFor="transfer-amount">Сумма/);
  assert.match(component, /Подходящие операции/);
  assert.match(component, /Создать операцию-напарника/);
  assert.match(component, /Связанные операции/);
  assert.match(component, /Синхронизировано со списанием/);
  assert.match(component, /Разъединить этот перевод\?/);
});

test("modal semantics live on the dialog rather than the overlay", () => {
  const operationModal = between(component, "{formOpen ? (", "</form>");
  const beforeDialog = between(
    operationModal,
    "className={`p1ModalOverlay",
    "ref={transactionDialogRef}"
  );
  assert.doesNotMatch(beforeDialog, /role="dialog"|aria-modal/);
  assert.match(operationModal, /role="dialog"/);
  assert.match(operationModal, /aria-modal="true"/);
  assert.match(operationModal, /aria-labelledby="phase1-operation-title"/);
});

test("main metadata failures use the prototype full-screen retry state", () => {
  assert.match(component, /className="p1ScreenError"/);
  assert.match(component, /Не удалось загрузить данные за/);
  assert.match(component, /Проверьте подключение к интернету и попробуйте ещё раз\./);
  assert.match(component, />Повторить<\/button>/);
  assert.match(css, /\.p1ScreenError\s*\{[^}]*min-height:\s*520px/);
  assert.match(css, /\.p1ScreenErrorCard\s*\{[^}]*border-radius:\s*18px/);
});
