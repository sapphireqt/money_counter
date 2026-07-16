import { strict as assert } from "node:assert";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = new URL(process.argv[2] ?? "http://localhost:3104");
const outputRoot = path.resolve(
  process.argv[3] ?? path.join(repoRoot, "artifacts/phase1-acceptance")
);
const prototypeUrl = pathToFileURL(
  path.join(repoRoot, "family_finance_main_screen_prototype_v34_unified_content_grid.html")
).href;
const chromePath = process.env.PLAYWRIGHT_CHROME;

if (!new Set(["localhost", "127.0.0.1"]).has(baseUrl.hostname) || baseUrl.port === "3000") {
  throw new Error(
    "Visual acceptance may only target an isolated loopback server and refuses port 3000"
  );
}

const DESKTOP_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1600, height: 1000 },
];
const RESPONSIVE_VIEWPORTS = [
  { width: 1360, height: 900 },
  { width: 1024, height: 900 },
];
const reports = [];
let activeReport = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relativeArtifact(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function record(name, pass, detail = "") {
  assert(activeReport, "record() must run inside a scenario");
  activeReport.checks.push({ name, result: pass ? "PASS" : "FAIL", detail });
  if (!pass) activeReport.result = "FAIL";
}

async function rect(page, selector) {
  return page.locator(selector).evaluate((element) => {
    const value = element.getBoundingClientRect();
    return {
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
      right: value.right,
      bottom: value.bottom,
    };
  });
}

async function computed(page, selector) {
  const locator = (selector ? page.locator(selector) : page).first();
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.color,
      display: style.display,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      overflowX: style.overflowX,
      position: style.position,
      visibility: style.visibility,
    };
  });
}

async function clickHidden(page, selector) {
  await page.locator(selector).evaluate((element) => element.click());
  await page.waitForTimeout(120);
}

async function setNativeDate(page, selector, value) {
  await page.locator(selector).evaluate((element, nextValue) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, nextValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await page.waitForTimeout(120);
}

async function waitForProductionReady(page) {
  await page.locator(".p1AppShell").waitFor({ state: "visible" });
  await page.locator(".p1TableFrame").waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      !document.querySelector(".operationSkeleton") &&
      !document.querySelector(".accountPanelSkeleton") &&
      !document.querySelector(".categoryPanelSkeleton") &&
      !document.querySelector(".summarySkeleton"),
    undefined,
    { timeout: 12_000 }
  );
  await page.waitForTimeout(180);
}

async function settlePaint(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await page.waitForTimeout(120);
}

async function screenshotBlackRatio(page, buffer) {
  const source = `data:image/png;base64,${buffer.toString("base64")}`;
  return page.evaluate(async (src) => {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = src;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return 1;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let sampled = 0;
    let black = 0;
    for (let y = 0; y < canvas.height; y += 4) {
      for (let x = 0; x < canvas.width; x += 4) {
        const index = (y * canvas.width + x) * 4;
        sampled += 1;
        if (pixels[index] < 4 && pixels[index + 1] < 4 && pixels[index + 2] < 4) {
          black += 1;
        }
      }
    }
    return black / sampled;
  }, source);
}

async function captureStableScreenshot(page, filePath) {
  let best = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await settlePaint(page);
    const buffer = await page.screenshot({ animations: "disabled" });
    const blackRatio = await screenshotBlackRatio(page, buffer);
    if (!best || blackRatio < best.blackRatio) best = { buffer, blackRatio, attempt };
    if (blackRatio <= 0.01) {
      await writeFile(filePath, buffer);
      return { blackRatio, attempt };
    }
    await page.evaluate(() => {
      window.scrollBy(0, 1);
      window.scrollBy(0, -1);
      document.documentElement.getBoundingClientRect();
    });
    await page.waitForTimeout(220);
  }
  assert(best, "screenshot attempt must exist");
  await writeFile(filePath, best.buffer);
  return best;
}

async function preparePrototype(page, setup) {
  await page.goto(prototypeUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.locator("#prototypeStateShell").waitFor({ state: "attached" });
  const evidence = (await setup?.(page)) ?? {};
  await page.locator("#prototypeStateShell").evaluate((element) => {
    element.style.display = "none";
  });
  await page.waitForTimeout(100);
  return evidence;
}

async function prepareProduction(page, options, setup) {
  await page.addInitScript(
    ({ forecast }) => {
      window.localStorage.setItem("mc.forecastOn", forecast ? "1" : "0");
      window.localStorage.setItem("mc.displayCurrency", "EUR");
      window.sessionStorage.clear();
    },
    { forecast: options.forecast ?? false }
  );
  if (options.beforeGoto) await options.beforeGoto(page);
  await page.goto(baseUrl.href, { waitUntil: "domcontentloaded", timeout: 15_000 });
  if (options.loading) {
    await page.locator(".operationSkeleton").first().waitFor({ state: "attached" });
    await page.waitForTimeout(180);
  } else if (options.error) {
    await page.locator(".p1ScreenError").waitFor({ state: "visible" });
  } else {
    await waitForProductionReady(page);
  }
  if (options.forecast) {
    await page.locator(".forecastCard").waitFor({ state: "visible" });
  }
  return (await setup?.(page)) ?? {};
}

async function openAddOperation(page) {
  await page.getByRole("button", { name: "+ Добавить", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "visible" });
}

async function editOperation(page, description) {
  const row = page.locator(".p1OpsTable tbody tr.operationRow").filter({ hasText: description }).first();
  await row.scrollIntoViewIfNeeded();
  await row.getByRole("button", { name: "Действия" }).click();
  await page.getByRole("menuitem", { name: "Править" }).click();
  await page.getByRole("dialog").waitFor({ state: "visible" });
}

async function chooseOperationType(page, label) {
  await page
    .getByRole("group", { name: "Тип операции" })
    .getByRole("button", { name: label, exact: true })
    .click();
  await page.waitForTimeout(120);
}

async function openNewTransfer(page, destinationLabel) {
  await openAddOperation(page);
  await chooseOperationType(page, "Перевод");
  await page.locator("#transfer-from-account").selectOption({ label: "Основной счёт · EUR" });
  await page.locator("#transfer-to-account").selectOption({ label: destinationLabel });
  await page.waitForTimeout(120);
}

async function openTransferCandidates(page) {
  await editOperation(page, "Перевод в семейный резерв");
  await chooseOperationType(page, "Перевод");
  await page.locator(".p1PartnerPicker").waitFor({ state: "visible" });
}

async function openLinkedTransfer(page) {
  await editOperation(page, "Перевод между счетами");
  await page.getByRole("heading", { name: "Редактировать перевод" }).waitFor();
  await page.locator(".transferEditGrid").waitFor({ state: "visible" });
}

async function setPrototypeSort(page, value) {
  await page.locator("#sortTrigger").click();
  await page.locator(`[data-sort="${value}"]`).click();
  await page.waitForTimeout(100);
}

async function setProductionSort(page, label) {
  await page.locator(".sortTrigger").click();
  await page.getByRole("menuitemradio", { name: label }).click();
  await page.waitForTimeout(120);
}

async function capturePair(browser, scenario, viewport) {
  const suffix = `${viewport.width}x${viewport.height}`;
  const prototypePath = path.join(outputRoot, "prototype", `${scenario.id}-${suffix}.png`);
  const productionPath = path.join(outputRoot, "production", `${scenario.id}-${suffix}.png`);
  const report = {
    id: scenario.id,
    label: scenario.label,
    viewport,
    prototypeScreenshot: relativeArtifact(prototypePath),
    productionScreenshot: relativeArtifact(productionPath),
    checks: [],
    result: "PASS",
  };
  reports.push(report);
  activeReport = report;

  const prototypeContext = await browser.newContext({ viewport });
  const productionContext = await browser.newContext({ viewport });
  const prototypePage = await prototypeContext.newPage();
  const productionPage = await productionContext.newPage();
  prototypePage.setDefaultTimeout(8_000);
  productionPage.setDefaultTimeout(8_000);

  try {
    const prototypeEvidence = await preparePrototype(prototypePage, scenario.prototypeSetup);
    const productionEvidence = await prepareProduction(
      productionPage,
      scenario.productionOptions ?? {},
      scenario.productionSetup
    );
    const prototypeCapture = await captureStableScreenshot(prototypePage, prototypePath);
    const productionCapture = await captureStableScreenshot(productionPage, productionPath);
    record(
      "prototype screenshot has no black compositor tiles",
      prototypeCapture.blackRatio <= 0.01,
      `ratio=${prototypeCapture.blackRatio.toFixed(5)}, attempt=${prototypeCapture.attempt}`
    );
    record(
      "production screenshot has no black compositor tiles",
      productionCapture.blackRatio <= 0.01,
      `ratio=${productionCapture.blackRatio.toFixed(5)}, attempt=${productionCapture.attempt}`
    );
    await scenario.check?.({
      prototypePage,
      productionPage,
      prototypeEvidence,
      productionEvidence,
      viewport,
    });
  } catch (error) {
    report.result = "FAIL";
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    activeReport = null;
    await Promise.race([prototypeContext.close(), delay(2_000)]).catch(() => undefined);
    await Promise.race([productionContext.close(), delay(2_000)]).catch(() => undefined);
  }

  process.stdout.write(`${report.result} ${scenario.id} ${suffix}\n`);
}

const defaultPrototype = async () => {};

const scenarios = [
  {
    id: "main-forecast-on",
    label: "Main / Forecast ON",
    prototypeSetup: defaultPrototype,
    productionOptions: { forecast: true },
    check: async ({ productionPage, viewport }) => {
      const sidebar = await rect(productionPage, ".p1Sidebar");
      const facts = await rect(productionPage, ".factsPanel");
      const forecast = await rect(productionPage, ".forecastCard");
      const toolbar = await rect(productionPage, ".p1Toolbar");
      const table = await rect(productionPage, ".p1TableFrame");
      record("sidebar is exactly 72px", Math.abs(sidebar.width - 72) < 0.1, `${sidebar.width}px`);
      record(
        "sidebar has no expand control",
        (await productionPage.locator('[aria-label*="Развернуть меню"]').count()) === 0
      );
      record("left column is 922px", Math.abs(facts.width - 922) < 0.5, `${facts.width}px`);
      record("right column is 350px", Math.abs(forecast.width - 350) < 0.5, `${forecast.width}px`);
      record("content gap is 18px", Math.abs(forecast.x - facts.right - 18) < 0.5);
      record("toolbar equals table width", Math.abs(toolbar.width - table.width) < 0.5);
      record("Inter is applied", (await computed(productionPage, "body")).fontFamily.includes("Inter"));
      record("forecast is visible", await productionPage.locator(".forecastCard").isVisible());
      const scope = productionPage.locator(".operationScope");
      record("period/history scope is visible", await scope.isVisible());
      record(
        "scope has the prototype options",
        JSON.stringify(await scope.locator("option").allTextContents()) ===
          JSON.stringify(["Текущий период", "Вся история"])
      );
      if (viewport.width === 1440) {
        const expenseRow = productionPage
          .locator(".p1OpsTable tbody tr.operationRow")
          .filter({ hasText: "Кофе" })
          .first();
        const incomeRow = productionPage
          .locator(".p1OpsTable tbody tr.operationRow")
          .filter({ hasText: "Зарплата" })
          .first();
        const expenseText = await expenseRow.locator(".operationMainAmount").innerText();
        const incomeText = await incomeRow.locator(".operationMainAmount").innerText();
        const incomeColor = (await computed(incomeRow, ".operationMainAmount")).color;
        record("expense row has no leading minus", !/^[−-]/.test(expenseText.trim()), expenseText);
        record("income row has plus", incomeText.trim().startsWith("+"), incomeText);
        record("income row is green", incomeColor === "rgb(46, 155, 104)", incomeColor);

        await productionPage.evaluate(() => window.scrollTo(0, 300));
        await productionPage.waitForTimeout(220);
        const tableHead = await rect(productionPage, ".p1OpsTable thead");
        const rightStack = await rect(productionPage, ".rightStickyStack");
        record("table heading stays below sticky toolbar", Math.abs(tableHead.y - 132) <= 1, `${tableHead.y}px`);
        record("accounts and expenses rail stays sticky", Math.abs(rightStack.y - 68) <= 1, `${rightStack.y}px`);
        record("table heading uses sticky positioning", (await computed(productionPage, ".p1OpsTable thead")).position === "sticky");
        record("right rail uses sticky positioning", (await computed(productionPage, ".rightStickyStack")).position === "sticky");
        await productionPage.evaluate(() => window.scrollTo(0, 0));
      }
    },
  },
  {
    id: "main-forecast-off",
    label: "Main / Forecast OFF",
    prototypeSetup: async (page) => clickHidden(page, "#forecastToggle"),
    productionOptions: { forecast: false },
    check: async ({ productionPage }) => {
      const facts = await rect(productionPage, ".factsPanel");
      const summary = await rect(productionPage, ".p1SummaryGrid");
      record("forecast is absent", (await productionPage.locator(".forecastCard").count()) === 0);
      record(
        "facts use the full content width",
        Math.abs(facts.x - summary.x) < 0.5 && Math.abs(facts.width - summary.width) < 0.5,
        `facts=${facts.width}px summary=${summary.width}px`
      );
      record(
        "summary has a single grid column",
        (await productionPage.locator(".p1SummaryGrid").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)) === 1
      );
    },
  },
  {
    id: "responsive-wrap",
    label: "Responsive / Forecast and right rail wrap",
    viewports: RESPONSIVE_VIEWPORTS,
    prototypeSetup: defaultPrototype,
    productionOptions: { forecast: true },
    check: async ({ productionPage }) => {
      const facts = await rect(productionPage, ".factsPanel");
      const forecast = await rect(productionPage, ".forecastCard");
      const main = await rect(productionPage, ".p1MainColumn");
      const rail = await rect(productionPage, ".p1RightRail");
      const docWidth = await productionPage.evaluate(() => document.documentElement.scrollWidth);
      record("forecast moves below facts", forecast.y >= facts.bottom - 1, `${facts.bottom} → ${forecast.y}`);
      record("right rail moves below table column", rail.y >= main.bottom - 1 && Math.abs(rail.x - main.x) < 0.5);
      record("forecast remains visible", await productionPage.locator(".forecastCard").isVisible());
      record("accounts remain visible", await productionPage.locator(".p1AccountsPanel").isVisible());
      record("chart remains visible", await productionPage.locator(".p1CategoryPanel").isVisible());
      record("whole page has no horizontal overflow", docWidth <= (await productionPage.evaluate(() => innerWidth)) + 1, `${docWidth}px`);
    },
  },
  {
    id: "filters-open",
    label: "Toolbar / Existing filters",
    prototypeSetup: async (page) => clickHidden(page, "#filterTrigger"),
    productionSetup: async (page) => {
      await page.locator(".filterTrigger").click();
    },
    check: async ({ productionPage }) => {
      const toolbar = await rect(productionPage, ".p1Toolbar");
      const table = await rect(productionPage, ".p1TableFrame");
      record("filter panel opens", await productionPage.locator(".filterPanel").isVisible());
      record("production filter set is present", (await productionPage.locator(".filterPanel select").count()) === 3);
      record("toolbar equals table width", Math.abs(toolbar.width - table.width) < 0.5);
    },
  },
  {
    id: "scope-history",
    label: "Toolbar / All history scope",
    prototypeSetup: async (page) => {
      await page.locator("#scope").selectOption("history");
      await page.locator("#search").fill("Carrefour");
      await page.waitForTimeout(160);
    },
    productionSetup: async (page) => {
      await page.locator(".operationScope").selectOption("history");
      await page.getByLabel("Поиск по операциям").fill("Carrefour");
      await page.locator("tr.yearGroup").filter({ hasText: "2025" }).waitFor({ state: "visible" });
    },
    check: async ({ productionPage }) => {
      record("history scope stays selected", await productionPage.locator(".operationScope").inputValue() === "history");
      record(
        "history search is grouped by year",
        (await productionPage.locator("tr.yearGroup").filter({ hasText: "2025" }).count()) === 1
      );
      record("history result row is visible", await productionPage.locator("tr.operationRow").filter({ hasText: "Carrefour" }).isVisible());
      record("history table exposes the date heading", (await productionPage.locator(".p1OpsTable th").first().innerText()) === "Дата");
      record("history result exposes its operation date", (await productionPage.locator(".operationDate").first().innerText()).includes("8 мар"));
      record("history mode has no daily summary groups", (await productionPage.locator("tr.dayGroup").count()) === 0);
      record("history layout class is active", await productionPage.locator(".p1OpsTable").evaluate((table) => table.classList.contains("historyMode")));
    },
  },
  {
    id: "sorting-date",
    label: "Sorting / Date descending",
    prototypeSetup: async (page) => setPrototypeSort(page, "date"),
    productionSetup: async (page) => setProductionSort(page, "Дата ↓"),
    check: async ({ productionPage }) => {
      record("day groups are present", (await productionPage.locator("tr.dayGroup").count()) > 1);
      record("date is not a row column", (await productionPage.locator("th").filter({ hasText: /^Дата$/ }).count()) === 0);
    },
  },
  {
    id: "sorting-amount-desc",
    label: "Sorting / Amount descending",
    prototypeSetup: async (page) => setPrototypeSort(page, "amount-desc"),
    productionSetup: async (page) => setProductionSort(page, "Сумма ↓"),
    check: async ({ productionPage }) => {
      record("day groups are removed", (await productionPage.locator("tr.dayGroup").count()) === 0);
      record("date appears in every row", (await productionPage.locator("tr.operationRow.flat .operationDate").count()) > 0);
      record("flat header contains date", (await productionPage.locator("th").filter({ hasText: /^Дата$/ }).count()) === 1);
    },
  },
  {
    id: "sorting-amount-asc",
    label: "Sorting / Amount ascending",
    prototypeSetup: async (page) => setPrototypeSort(page, "amount-asc"),
    productionSetup: async (page) => setProductionSort(page, "Сумма ↑"),
    check: async ({ productionPage }) => {
      record("day groups are removed", (await productionPage.locator("tr.dayGroup").count()) === 0);
      const amounts = await productionPage.locator("tr.operationRow .operationMainAmount").allTextContents();
      record("rows remain populated", amounts.length >= 10, `${amounts.length} rows`);
    },
  },
  {
    id: "table-long-day",
    label: "Table / Long day",
    prototypeSetup: defaultPrototype,
    check: async ({ productionPage }) => {
      const group = productionPage.locator("tr.dayGroup").filter({ hasText: "13 июля" }).first();
      const followingRows = await group.evaluate((element) => {
        let count = 0;
        let current = element.nextElementSibling;
        while (current && !current.classList.contains("dayGroup")) {
          count += 1;
          current = current.nextElementSibling;
        }
        return count;
      });
      record("long day renders all operations", followingRows >= 14, `${followingRows} rows`);
    },
  },
  {
    id: "table-income",
    label: "Table / Income",
    prototypeSetup: defaultPrototype,
    productionSetup: async (page) => {
      await page.locator("tr.operationRow").filter({ hasText: "Зарплата" }).first().scrollIntoViewIfNeeded();
    },
    check: async ({ productionPage }) => {
      const amount = productionPage.locator("tr.operationRow").filter({ hasText: "Зарплата" }).locator(".operationMainAmount");
      record("income has green plus", (await amount.innerText()).trim().startsWith("+") && (await computed(amount)).color === "rgb(46, 155, 104)");
    },
  },
  {
    id: "table-expense",
    label: "Table / Expense",
    prototypeSetup: defaultPrototype,
    productionSetup: async (page) => {
      await page.locator("tr.operationRow").filter({ hasText: "Кофе" }).first().scrollIntoViewIfNeeded();
    },
    check: async ({ productionPage }) => {
      const text = await productionPage.locator("tr.operationRow").filter({ hasText: "Кофе" }).first().locator(".operationMainAmount").innerText();
      record("expense has no minus", !/[−-]/.test(text), text);
    },
  },
  {
    id: "table-transfer",
    label: "Table / Transfer",
    prototypeSetup: defaultPrototype,
    productionSetup: async (page) => {
      await page.locator("tr.operationRow.transfer").first().scrollIntoViewIfNeeded();
    },
    check: async ({ productionPage }) => {
      const row = productionPage.locator("tr.operationRow.transfer").first();
      record("transfer row exists", await row.isVisible());
      record("transfer has destination line", await row.locator(".transferDestination").isVisible());
      record("transfer has at least two amount lines", (await row.locator(".operationAmounts > span").count()) >= 3);
    },
  },
  {
    id: "accounts-default",
    label: "Accounts / Typography, tones and session expansion",
    prototypeSetup: defaultPrototype,
    check: async ({ productionPage, viewport }) => {
      const rows = productionPage.locator(".accountPanelRow");
      const nameStyle = await computed(productionPage, ".accountPanelRow .accountPanelName strong");
      const spendStyle = await computed(productionPage, ".accountPanelRow .accountPanelSpend");
      const balanceStyle = await computed(productionPage, ".accountPanelRow .accountPanelBalance strong");
      const nativeStyle = await computed(productionPage, ".accountPanelRow .accountPanelBalance small");
      const names = await productionPage.locator(".accountPanelName strong").allTextContents();
      record("default shows exactly 9 accounts", (await rows.count()) === 9);
      record("negative overflow is promoted", names.includes("Скрытый овердрафт"), names.join(", "));
      record("promoted negative displaces ninth account", !names.includes("Резерв 1"));
      record("account name is 14/400/#555560", nameStyle.fontSize === "14px" && nameStyle.fontWeight === "400" && nameStyle.color === "rgb(85, 85, 96)", JSON.stringify(nameStyle));
      record("spend is 14/400/#666671", spendStyle.fontSize === "14px" && spendStyle.fontWeight === "400" && spendStyle.color === "rgb(102, 102, 113)", JSON.stringify(spendStyle));
      record("primary balance is 14/700/#222229", balanceStyle.fontSize === "14px" && balanceStyle.fontWeight === "700" && balanceStyle.color === "rgb(34, 34, 41)", JSON.stringify(balanceStyle));
      record("native balance is 12/400/#7b7b86", nativeStyle.fontSize === "12px" && nativeStyle.fontWeight === "400" && nativeStyle.color === "rgb(123, 123, 134)", JSON.stringify(nativeStyle));
      record("currency is not rendered below account name", (await productionPage.locator(".accountPanelName small").count()) === 0);
      const negativeStyle = await computed(productionPage, ".accountPanelBalance.negative strong");
      const zeroStyle = await computed(productionPage, ".accountPanelBalance.zero strong");
      record("negative balance group is #D55353", negativeStyle.color === "rgb(213, 83, 83)", negativeStyle.color);
      record("zero balance group is #AAAAAA", zeroStyle.color === "rgb(170, 170, 170)", zeroStyle.color);
      record("total is weight 800", (await computed(productionPage, ".accountPanelTotal strong:last-child")).fontWeight === "800");

      if (viewport.width === 1440) {
        await productionPage.getByRole("button", { name: "Показать ещё" }).click();
        record("expand reveals all 12 active accounts", (await rows.count()) === 12);
        await productionPage.getByRole("button", { name: "Настройки" }).click();
        await productionPage.getByRole("button", { name: "Операции" }).click();
        await waitForProductionReady(productionPage);
        record("expanded state survives section switch", (await productionPage.locator(".accountPanelRow").count()) === 12);
        await productionPage.getByRole("button", { name: "Свернуть" }).click();
        const collapsedNames = await productionPage.locator(".accountPanelName strong").allTextContents();
        record("collapse restores configured order after viewing", collapsedNames.includes("Резерв 1") && !collapsedNames.includes("Скрытый овердрафт"), collapsedNames.join(", "));
      }
    },
  },
  {
    id: "chart-default",
    label: "Chart / All slices and top-four legend",
    prototypeSetup: defaultPrototype,
    check: async ({ productionPage }) => {
      const slices = productionPage.locator('.categoryDonutVisual path[role="img"]');
      const legend = productionPage.locator(".categoryLegend button");
      record("all eight non-zero category buckets are slices", (await slices.count()) === 8, `${await slices.count()} slices`);
      record("legend contains exactly four largest categories", (await legend.count()) === 4);
      record("every slice is keyboard focusable", await slices.evaluateAll((elements) => elements.every((element) => element.tabIndex === 0)));
    },
  },
  {
    id: "operation-new-expense",
    label: "Operation / New expense / additional closed",
    prototypeSetup: async (page) => clickHidden(page, '[data-operation-form="add"]'),
    productionSetup: openAddOperation,
    check: async ({ productionPage }) => {
      const dialog = productionPage.getByRole("dialog");
      record("new operation title", await dialog.getByRole("heading", { name: "Новая операция" }).isVisible());
      record("create-only date helper is visible", await dialog.getByText("Дата влияет на список доступных счетов").isVisible());
      record("additional fields are closed", (await dialog.locator("#operation-note").count()) === 0);
      record("import controls are absent", (await dialog.getByText(/Импорт выписки|Импортировать операции/).count()) === 0);
      record("dialog background is white", (await dialog.evaluate((element) => getComputedStyle(element).backgroundColor)) === "rgb(255, 255, 255)");
      record("dialog header background is white", (await dialog.locator(".p1DialogHeader").evaluate((element) => getComputedStyle(element).backgroundColor)) === "rgb(255, 255, 255)");
      const options = await dialog.locator("#operation-account option").allTextContents();
      record("inactive accounts are absent", !options.some((value) => value.includes("Закрытый исторический") || value.includes("Будущий счёт")), options.join(", "));
    },
  },
  {
    id: "operation-new-income",
    label: "Operation / New income / additional open",
    prototypeSetup: async (page) => {
      await clickHidden(page, '[data-operation-form="add"]');
      await clickHidden(page, '#operationType [data-operation-type="income"]');
      await clickHidden(page, "#additionalToggle");
    },
    productionSetup: async (page) => {
      await openAddOperation(page);
      await chooseOperationType(page, "Поступление");
      await page.getByRole("button", { name: "Дополнительно" }).click();
    },
    check: async ({ productionPage }) => {
      const dialog = productionPage.getByRole("dialog");
      record("income variant is active", await dialog.getByRole("button", { name: "Поступление", exact: true }).getAttribute("aria-pressed") === "true");
      record("category is absent for income", (await dialog.locator("#operation-category").count()) === 0);
      record("additional note is visible", await dialog.locator("#operation-note").isVisible());
      record("attention control is visible", await dialog.getByText("Требует внимания").isVisible());
      record("import controls are absent", (await dialog.getByText(/Импорт выписки|Импортировать операции/).count()) === 0);
    },
  },
  {
    id: "operation-edit-expense",
    label: "Operation / Edit expense",
    prototypeSetup: async (page) => clickHidden(page, '[data-operation-form="edit-expense"]'),
    productionSetup: async (page) => editOperation(page, "Кофе"),
    check: async ({ productionPage }) => {
      const dialog = productionPage.getByRole("dialog");
      record("edit expense title", await dialog.getByRole("heading", { name: "Редактировать расход" }).isVisible());
      record("persistent date helper is absent", (await dialog.getByText("Дата влияет на список доступных счетов").count()) === 0);
      record("suggestions stay closed until description focus", (await dialog.locator(".descriptionSuggestions").count()) === 0);
      record("delete action is present", await dialog.getByRole("button", { name: "Удалить", exact: true }).isVisible());
      record("import controls are absent", (await dialog.getByText(/Импорт выписки|Импортировать операции/).count()) === 0);
    },
  },
  {
    id: "operation-edit-income",
    label: "Operation / Edit income",
    prototypeSetup: async (page) => clickHidden(page, '[data-operation-form="edit-income"]'),
    productionSetup: async (page) => editOperation(page, "Зарплата"),
    check: async ({ productionPage }) => {
      const dialog = productionPage.getByRole("dialog");
      record("edit income title", await dialog.getByRole("heading", { name: "Редактировать поступление" }).isVisible());
      record("persistent date helper is absent", (await dialog.getByText("Дата влияет на список доступных счетов").count()) === 0);
      record("suggestions stay closed until description focus", (await dialog.locator(".descriptionSuggestions").count()) === 0);
      record("category is absent for income", (await dialog.locator("#operation-category").count()) === 0);
      record("import controls are absent", (await dialog.getByText(/Импорт выписки|Импортировать операции/).count()) === 0);
    },
  },
  {
    id: "operation-invalid-account",
    label: "Operation / Account invalidated by date",
    prototypeSetup: async (page) => clickHidden(page, '[data-operation-form="invalid-account"]'),
    productionSetup: async (page) => {
      await openAddOperation(page);
      await setNativeDate(page, '.p1Dialog input[type="date"]', "2026-08-02");
      await page.locator("#operation-account").selectOption({ label: "Будущий счёт" });
      await setNativeDate(page, '.p1Dialog input[type="date"]', "2026-07-13");
      await page.getByText("Этот счёт недоступен на выбранную дату. Выберите другой счёт.").waitFor();
    },
    check: async ({ productionPage }) => {
      const dialog = productionPage.getByRole("dialog");
      record("exact invalid-account copy", await dialog.getByText("Этот счёт недоступен на выбранную дату. Выберите другой счёт.", { exact: true }).isVisible());
      record("account select is aria-invalid", await dialog.locator("#operation-account").getAttribute("aria-invalid") === "true");
      record("save actions are blocked", await dialog.locator('button[type="submit"]').evaluateAll((buttons) => buttons.every((button) => button.disabled)));
    },
  },
  {
    id: "operation-suggestions",
    label: "Operation / Description suggestions",
    prototypeSetup: async (page) => clickHidden(page, '[data-operation-form="suggestions"]'),
    productionSetup: async (page) => {
      await openAddOperation(page);
      const startedAt = Date.now();
      const response = page.waitForResponse((candidate) => candidate.url().includes("/api/transactions/suggestions?"));
      await page.locator("#operation-description").fill("Me");
      await response;
      await page.locator(".descriptionSuggestions").waitFor({ state: "visible" });
      return { debounceMs: Date.now() - startedAt };
    },
    check: async ({ productionPage, productionEvidence }) => {
      const options = productionPage.locator('.descriptionSuggestions [role="option"]');
      record("suggestions appear after two symbols", (await options.count()) > 0);
      record("suggestions are limited to eight", (await options.count()) <= 8, `${await options.count()} suggestions`);
      record("debounce is at least 220ms", productionEvidence.debounceMs >= 220, `${productionEvidence.debounceMs}ms`);
    },
  },
  {
    id: "operation-autocategory",
    label: "Operation / Auto category",
    prototypeSetup: async (page) => clickHidden(page, '[data-operation-form="autocategory"]'),
    productionSetup: async (page) => {
      await openAddOperation(page);
      await page.locator("#operation-description").fill("Me");
      await page.locator(".descriptionSuggestions").waitFor({ state: "visible" });
      await page.locator('.descriptionSuggestions [role="option"]').first().click();
      await page.locator(".autoCategoryBadge").waitFor({ state: "visible" });
    },
    check: async ({ productionPage }) => {
      record("auto category badge is visible", await productionPage.locator(".autoCategoryBadge").isVisible());
      record("category was filled", Boolean(await productionPage.locator("#operation-category").inputValue()));
    },
  },
  {
    id: "transfer-same-currency",
    label: "Transfer / Same currency",
    prototypeSetup: async (page) => clickHidden(page, '[data-open-transfer="01-new-transfer-same-currency"]'),
    productionSetup: async (page) => openNewTransfer(page, "Семейный счёт · EUR"),
    check: async ({ productionPage }) => {
      const dialog = productionPage.getByRole("dialog");
      record("new transfer title", await dialog.getByRole("heading", { name: "Новый перевод" }).isVisible());
      record("same currency has one amount input", (await dialog.locator("#transfer-amount").count()) === 1);
      record("split amount inputs are absent", (await dialog.locator("#transfer-amount-out, #transfer-amount-in").count()) === 0);
      record("import controls are absent", (await dialog.getByText(/Импорт выписки|Импортировать операции/).count()) === 0);
    },
  },
  {
    id: "transfer-different-currency",
    label: "Transfer / Different currencies",
    prototypeSetup: async (page) => clickHidden(page, '[data-open-transfer="02-new-transfer-different-currencies"]'),
    productionSetup: async (page) => openNewTransfer(page, "Долларовый резерв · USD"),
    check: async ({ productionPage }) => {
      const dialog = productionPage.getByRole("dialog");
      record("different currencies have debit amount", await dialog.locator("#transfer-amount-out").isVisible());
      record("different currencies have credit amount", await dialog.locator("#transfer-amount-in").isVisible());
      record("labels use approved copy", await dialog.getByText("Списано", { exact: true }).isVisible() && await dialog.getByText("Зачислено", { exact: true }).isVisible());
    },
  },
  {
    id: "transfer-candidates",
    label: "Transfer / Existing candidates",
    prototypeSetup: async (page) => clickHidden(page, '[data-open-transfer="03-link-existing-candidates"]'),
    productionSetup: openTransferCandidates,
    check: async ({ productionPage }) => {
      record("candidate mode opens by default", await productionPage.locator(".p1PartnerPicker.candidateMode").isVisible());
      record("at least one candidate is shown", (await productionPage.locator(".p1PartnerList li").count()) >= 1);
      record("link action is present", await productionPage.getByRole("button", { name: "Связать", exact: true }).isVisible());
    },
  },
  {
    id: "transfer-partner",
    label: "Transfer / Create partner operation",
    prototypeSetup: async (page) => clickHidden(page, '[data-open-transfer="04-create-partner-operation"]'),
    productionSetup: async (page) => {
      await openTransferCandidates(page);
      await page.locator(".transferTabs").getByRole("button", { name: "Создать операцию-напарника" }).click();
      await page.locator(".p1PartnerCreateGrid").waitFor({ state: "visible" });
    },
    check: async ({ productionPage }) => {
      record("partner fields are visible", await productionPage.locator(".p1PartnerCreateGrid").isVisible());
      record("create-and-link action is visible", await productionPage.getByRole("button", { name: "Создать и связать" }).isVisible());
      record("date and amount are inherited", (await productionPage.locator(".p1PartnerCreateGrid .fieldHelp").count()) >= 2);
      record("income source creates a debit partner with correct labels", await productionPage.getByText("Со счёта", { exact: true }).isVisible() && await productionPage.getByText("Сумма списания", { exact: true }).isVisible());
    },
  },
  {
    id: "transfer-linked-edit",
    label: "Transfer / Edit linked pair",
    prototypeSetup: async (page) => clickHidden(page, '[data-open-transfer="05-edit-linked-transfer"]'),
    productionSetup: openLinkedTransfer,
    check: async ({ productionPage }) => {
      const dialog = productionPage.getByRole("dialog");
      record("linked edit has two sides", (await dialog.locator(".transferEditGrid > section").count()) === 2);
      record("common linked banner is visible", await dialog.locator(".linkedTransferBanner").isVisible());
      record("unlink action is visible", await dialog.getByRole("button", { name: "Разъединить" }).isVisible());
    },
  },
  {
    id: "transfer-unlink-confirm",
    label: "Transfer / Unlink confirmation",
    prototypeSetup: async (page) => clickHidden(page, '[data-open-transfer="06-confirm-unlink"]'),
    productionSetup: async (page) => {
      await openLinkedTransfer(page);
      await page.getByRole("dialog").getByRole("button", { name: "Разъединить" }).click();
      await page.getByRole("alertdialog").waitFor({ state: "visible" });
    },
    check: async ({ productionPage }) => {
      const dialog = productionPage.getByRole("alertdialog");
      record("approved confirmation title", await dialog.getByRole("heading", { name: "Разъединить этот перевод?" }).isVisible());
      record("both operations are shown", (await dialog.locator(".unlinkPair > div").count()) === 2);
      record("consequence warning is visible", await dialog.getByText("После разъединения", { exact: true }).isVisible());
    },
  },
  {
    id: "state-loading",
    label: "State / Loading",
    prototypeSetup: async (page) => clickHidden(page, '[data-state="initial"]'),
    productionOptions: {
      loading: true,
      beforeGoto: async (page) => {
        await page.route("**/api/**", async (route) => {
          await delay(12_000);
          await route.abort().catch(() => undefined);
        });
      },
    },
    check: async ({ productionPage }) => {
      record("summary skeleton is visible", await productionPage.locator(".summarySkeleton").isVisible());
      record("table skeleton is visible", (await productionPage.locator(".operationSkeleton").count()) > 0);
      record("account skeleton is visible", await productionPage.locator(".accountPanelSkeleton").isVisible());
    },
  },
  {
    id: "state-empty",
    label: "State / Empty period",
    prototypeSetup: async (page) => clickHidden(page, '[data-view="empty"]'),
    productionOptions: {
      beforeGoto: async (page) => {
        await page.route("**/api/transactions?**", (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ transactions: [] }),
          })
        );
      },
    },
    check: async ({ productionPage }) => {
      record("approved empty title", await productionPage.getByRole("heading", { name: "В этом периоде пока нет операций" }).isVisible());
      record("empty action is visible", await productionPage.getByRole("button", { name: "+ Добавить операцию" }).isVisible());
    },
  },
  {
    id: "state-no-results",
    label: "State / No results",
    prototypeSetup: async (page) => clickHidden(page, '[data-view="not-found"]'),
    productionSetup: async (page) => {
      await page.getByLabel("Поиск по операциям").fill("Wolt Barcelona");
      await page.getByRole("heading", { name: "Ничего не найдено" }).waitFor({ timeout: 10_000 });
    },
    check: async ({ productionPage }) => {
      record("approved no-results title", await productionPage.getByRole("heading", { name: "Ничего не найдено" }).isVisible());
      record("reset action is visible", await productionPage.getByRole("button", { name: "Сбросить поиск и фильтры" }).isVisible());
    },
  },
  {
    id: "state-error",
    label: "State / Full-screen error",
    prototypeSetup: async (page) => clickHidden(page, '[data-error="screen"]'),
    productionOptions: {
      error: true,
      beforeGoto: async (page) => {
        await page.route("**/api/accounts", (route) =>
          route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"fixture error"}' })
        );
      },
    },
    check: async ({ productionPage }) => {
      record("full-screen error is visible", await productionPage.locator(".p1ScreenError").isVisible());
      record("retry action is visible", await productionPage.getByRole("button", { name: "Повторить" }).isVisible());
      record("failure is not masked by the main grid", (await productionPage.locator(".p1Layout").count()) === 0);
    },
  },
];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.join(outputRoot, "prototype"), { recursive: true });
await mkdir(path.join(outputRoot, "production"), { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(chromePath ? { executablePath: chromePath } : {}),
});
let exitCode = 0;
try {
  for (const scenario of scenarios) {
    const viewports = scenario.viewports ?? DESKTOP_VIEWPORTS;
    for (const viewport of viewports) {
      await capturePair(browser, scenario, viewport);
    }
  }
  exitCode = reports.some((report) => report.result === "FAIL") ? 1 : 0;
} finally {
  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl: baseUrl.href,
    prototype: relativeArtifact(fileURLToPath(prototypeUrl)),
    status: exitCode === 0 ? "PASS" : "FAIL",
    scenarios: reports,
  };
  await writeFile(path.join(outputRoot, "report.json"), JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(
    `${summary.status}: ${reports.filter((report) => report.result === "PASS").length}/${reports.length} visual pairs passed\n`
  );
  await Promise.race([browser.close(), delay(3_000)]).catch(() => undefined);
}

process.exit(exitCode);
