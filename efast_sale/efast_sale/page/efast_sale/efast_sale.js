/**
 * eFast Sale — Interfaz rápida tipo POS para Sales Invoice
 * Frappe v15 compatible | Sin dependencias externas
 * Toda la lógica fiscal/contable permanece en ERPNext core.
 */

// ---------------------------------------------------------------------------
// Page lifecycle hooks
// ---------------------------------------------------------------------------

frappe.pages["efast-sale"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "eFast Sale",
		single_column: true,
	});
	wrapper.efast = new EFastSalePage(page, wrapper);
};

frappe.pages["efast-sale"].on_page_show = function (wrapper) {
	if (!wrapper.efast) return;
	const params = frappe.utils.get_url_to_dict();
	if (params.invoice) {
		wrapper.efast.load_invoice(params.invoice);
	}
};

// ---------------------------------------------------------------------------
// Main Controller
// ---------------------------------------------------------------------------

class EFastSalePage {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = wrapper;
		this.$body = $(page.body);
		this.doc = this._empty_doc();
		this.defaults = {};
		this.controls = {}; // Frappe ControlLink instances (header)
		this._loading = false;

		this._inject_styles();
		this._render_html();
		this._setup_action_bar();
		this._load_defaults_then_init();
	}

	// -----------------------------------------------------------------------
	// Initialization
	// -----------------------------------------------------------------------

	_load_defaults_then_init() {
		frappe.call({
			method: "efast_sale.api.invoice.get_defaults",
			freeze: false,
			callback: (r) => {
				if (!r.exc && r.message) {
					this.defaults = r.message;
				}
				this._setup_header_controls();
				this._setup_item_table();
				this._bind_events();
				this._new_invoice();
			},
		});
	}

	_empty_doc() {
		return {
			doctype: "Sales Invoice",
			name: "new",
			docstatus: 0,
			naming_series: "",
			customer: "",
			posting_date: frappe.datetime.get_today(),
			due_date: frappe.datetime.get_today(),
			payment_terms_template: "",
			terms: "",
			taxes_and_charges: "",
			bfel_nit: "",
			bfel_status: "01 Enviar",
			company: "",
			currency: "GTQ",
			items: [],
			taxes: [],
			total: 0,
			total_taxes_and_charges: 0,
			discount_amount: 0,
			grand_total: 0,
			in_words: "",
		};
	}

	_new_invoice() {
		this.doc = this._empty_doc();
		this.doc.company = this.defaults.company || "";
		this.doc.naming_series = (this.defaults.naming_series || [])[0] || "SINV-.YYYY.-";
		this.doc.taxes_and_charges = this.defaults.default_taxes_and_charges || "";
		this.doc.bfel_status = "01 Enviar";
		this.doc.posting_date = frappe.datetime.get_today();
		this.doc.due_date = frappe.datetime.get_today();
		this._sync_ui_from_doc();
		this._update_footer();
		this._update_action_bar_state();
		this.$body.find("#ef-status-badge").text("NUEVO").removeClass().addClass("ef-badge ef-badge-new");
		this.$body.find("#ef-doc-name").text("");
		this._focus_first_field();
	}

	// -----------------------------------------------------------------------
	// HTML Render
	// -----------------------------------------------------------------------

	_render_html() {
		this.$body.html(`
<div class="ef-wrapper">

  <!-- ── HEADER ──────────────────────────────────────────────────── -->
  <div class="ef-header">
    <div class="ef-header-top">
      <div class="ef-doc-info">
        <span id="ef-status-badge" class="ef-badge ef-badge-new">NUEVO</span>
        <span id="ef-doc-name" class="ef-doc-name"></span>
      </div>
      <div class="ef-header-title">eFast Sale</div>
    </div>

    <div class="ef-header-fields">

      <!-- Columna 1 -->
      <div class="ef-field-col">
        <div class="ef-field-group">
          <label class="ef-label">Serie <span class="ef-req">*</span></label>
          <select id="ef-naming-series" class="ef-select"></select>
        </div>
        <div class="ef-field-group">
          <label class="ef-label">Cliente <span class="ef-req">*</span></label>
          <div data-ctrl="customer" class="ef-link-ctrl"></div>
        </div>
        <div class="ef-field-group">
          <label class="ef-label">Fecha Emisión <span class="ef-req">*</span></label>
          <input id="ef-posting-date" type="date" class="ef-input" />
        </div>
        <div class="ef-field-group">
          <label class="ef-label">Fecha Vencimiento</label>
          <input id="ef-due-date" type="date" class="ef-input" />
        </div>
      </div>

      <!-- Columna 2 -->
      <div class="ef-field-col">
        <div class="ef-field-group">
          <label class="ef-label">Condición de Pago</label>
          <div data-ctrl="payment_terms_template" class="ef-link-ctrl"></div>
        </div>
        <div class="ef-field-group">
          <label class="ef-label">Plantilla Impuestos</label>
          <div data-ctrl="taxes_and_charges" class="ef-link-ctrl"></div>
        </div>
        <div class="ef-field-group">
          <label class="ef-label">NIT Cliente (FEL)</label>
          <input id="ef-bfel-nit" type="text" class="ef-input" placeholder="CF" maxlength="20" />
        </div>
        <div class="ef-field-group">
          <label class="ef-label">Estado FEL</label>
          <select id="ef-bfel-status" class="ef-select">
            <option value="01 Enviar">01 Enviar</option>
            <option value="00 No enviar">00 No enviar</option>
          </select>
        </div>
      </div>

      <!-- Columna 3 -->
      <div class="ef-field-col ef-field-col--wide">
        <div class="ef-field-group ef-field-full">
          <label class="ef-label">Términos y Condiciones</label>
          <textarea id="ef-terms" class="ef-textarea" rows="5" placeholder="Términos y condiciones..."></textarea>
        </div>
      </div>

    </div>
  </div>

  <!-- ── ITEMS TABLE ──────────────────────────────────────────────── -->
  <div class="ef-items-section">
    <div class="ef-items-header">
      <span class="ef-section-title">Detalle de Productos / Servicios</span>
      <button id="ef-add-row" class="ef-btn ef-btn-sm ef-btn-secondary">
        <span>+</span> Agregar Línea
      </button>
    </div>

    <div class="ef-table-wrapper">
      <table class="ef-table" id="ef-items-table">
        <thead>
          <tr>
            <th class="ef-th ef-th-idx">#</th>
            <th class="ef-th ef-th-item">Código Item</th>
            <th class="ef-th ef-th-name">Nombre / Descripción</th>
            <th class="ef-th ef-th-wh">Almacén</th>
            <th class="ef-th ef-th-qty">Cantidad</th>
            <th class="ef-th ef-th-rate">Precio Unit.</th>
            <th class="ef-th ef-th-disc">Desc %</th>
            <th class="ef-th ef-th-amount">Importe</th>
            <th class="ef-th ef-th-cc">Centro Costo</th>
            <th class="ef-th ef-th-del"></th>
          </tr>
        </thead>
        <tbody id="ef-items-body">
          <!-- rows injected by JS -->
        </tbody>
      </table>
    </div>

    <div id="ef-items-empty" class="ef-empty-state" style="display:none">
      <p>Sin líneas. Haga clic en <strong>Agregar Línea</strong> o presione <kbd>F2</kbd>.</p>
    </div>
  </div>

  <!-- ── FOOTER TOTALES ───────────────────────────────────────────── -->
  <div class="ef-footer">
    <div class="ef-footer-inner">
      <div class="ef-totals">
        <div class="ef-total-row">
          <span class="ef-total-label">Subtotal</span>
          <span id="ef-subtotal" class="ef-total-value">Q 0.00</span>
        </div>
        <div class="ef-total-row">
          <span class="ef-total-label">Descuentos</span>
          <span id="ef-discounts" class="ef-total-value ef-total-discount">- Q 0.00</span>
        </div>
        <div class="ef-total-row">
          <span class="ef-total-label">Impuestos</span>
          <span id="ef-taxes" class="ef-total-value">Q 0.00</span>
        </div>
        <div class="ef-total-row ef-total-row--grand">
          <span class="ef-total-label">TOTAL</span>
          <span id="ef-grand-total" class="ef-total-value ef-grand">Q 0.00</span>
        </div>
        <div class="ef-words-row">
          <span id="ef-words" class="ef-words"></span>
        </div>
      </div>
    </div>
  </div>

  <!-- Spacer para que la accion bar no tape el footer -->
  <div style="height: 80px;"></div>

</div><!-- ef-wrapper -->
		`);
	}

	// -----------------------------------------------------------------------
	// Styles (inline — no build step needed)
	// -----------------------------------------------------------------------

	_inject_styles() {
		if (document.getElementById("ef-styles")) return;
		const css = `
/* ── eFast Sale Styles ───────────────────────────────────────────────── */
:root {
  --ef-primary: #4361ee;
  --ef-primary-dark: #3a0ca3;
  --ef-success: #2dc653;
  --ef-warning: #f8961e;
  --ef-danger: #e63946;
  --ef-info: #4cc9f0;
  --ef-bg: #f8f9fb;
  --ef-card: #ffffff;
  --ef-border: #e2e8f0;
  --ef-text: #1e293b;
  --ef-text-muted: #64748b;
  --ef-radius: 8px;
  --ef-shadow: 0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.06);
  --ef-shadow-lg: 0 10px 25px rgba(0,0,0,.12);
  --ef-font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.ef-wrapper {
  font-family: var(--ef-font);
  background: var(--ef-bg);
  min-height: 100vh;
  color: var(--ef-text);
  font-size: 13px;
}

/* Header */
.ef-header {
  background: var(--ef-card);
  border-bottom: 1px solid var(--ef-border);
  padding: 16px 20px 12px;
  position: sticky;
  top: 0;
  z-index: 100;
  box-shadow: var(--ef-shadow);
}
.ef-header-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.ef-doc-info { display: flex; align-items: center; gap: 10px; }
.ef-doc-name { font-size: 15px; font-weight: 600; color: var(--ef-primary); }
.ef-header-title { font-size: 18px; font-weight: 700; color: var(--ef-text); letter-spacing: -0.3px; }

/* Badge */
.ef-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .5px;
  text-transform: uppercase;
}
.ef-badge-new      { background: #e2e8f0; color: #475569; }
.ef-badge-draft    { background: #dbeafe; color: #1d4ed8; }
.ef-badge-submitted{ background: #dcfce7; color: #166534; }
.ef-badge-certified{ background: #fef3c7; color: #92400e; }
.ef-badge-cancelled{ background: #fee2e2; color: #991b1b; }

/* Header field grid */
.ef-header-fields {
  display: grid;
  grid-template-columns: 1fr 1fr 1.2fr;
  gap: 0 24px;
}
.ef-field-col { display: flex; flex-direction: column; gap: 8px; }
.ef-field-col--wide {}
.ef-field-group { display: flex; flex-direction: column; gap: 3px; }
.ef-field-full { flex: 1; }

.ef-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--ef-text-muted);
  text-transform: uppercase;
  letter-spacing: .4px;
}
.ef-req { color: var(--ef-danger); }

.ef-input, .ef-select, .ef-textarea {
  width: 100%;
  border: 1px solid var(--ef-border);
  border-radius: 5px;
  padding: 6px 9px;
  font-size: 13px;
  color: var(--ef-text);
  background: #fff;
  transition: border-color .15s;
  font-family: var(--ef-font);
  box-sizing: border-box;
}
.ef-input:focus, .ef-select:focus, .ef-textarea:focus {
  outline: none;
  border-color: var(--ef-primary);
  box-shadow: 0 0 0 3px rgba(67,97,238,.12);
}
.ef-textarea { resize: vertical; min-height: 80px; }
.ef-select { cursor: pointer; }

/* Override Frappe control dentro del header */
.ef-link-ctrl .control-value,
.ef-link-ctrl .form-control,
.ef-link-ctrl input[data-fieldname] {
  border: 1px solid var(--ef-border) !important;
  border-radius: 5px !important;
  padding: 6px 9px !important;
  font-size: 13px !important;
  height: auto !important;
  box-shadow: none !important;
}
.ef-link-ctrl .control-label { display: none !important; }
.ef-link-ctrl .form-group { margin-bottom: 0 !important; }
.ef-link-ctrl .link-btn { top: 6px !important; }
.ef-link-ctrl .clearfix { display: none !important; }

/* Items section */
.ef-items-section {
  background: var(--ef-card);
  margin: 12px 0 0;
  border-top: 1px solid var(--ef-border);
  border-bottom: 1px solid var(--ef-border);
}
.ef-items-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  border-bottom: 1px solid var(--ef-border);
}
.ef-section-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .5px;
  color: var(--ef-text-muted);
}

/* Table */
.ef-table-wrapper { overflow-x: auto; }
.ef-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.ef-th {
  background: #f1f5f9;
  padding: 8px 10px;
  text-align: left;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .4px;
  color: var(--ef-text-muted);
  border-bottom: 2px solid var(--ef-border);
  white-space: nowrap;
}
.ef-th-idx   { width: 36px; text-align: center; }
.ef-th-item  { width: 160px; }
.ef-th-name  { min-width: 180px; }
.ef-th-wh    { width: 130px; }
.ef-th-qty   { width: 70px; text-align: right; }
.ef-th-rate  { width: 100px; text-align: right; }
.ef-th-disc  { width: 70px; text-align: right; }
.ef-th-amount{ width: 110px; text-align: right; }
.ef-th-cc    { width: 130px; }
.ef-th-del   { width: 36px; }

.ef-tr {
  border-bottom: 1px solid #f1f5f9;
  transition: background .1s;
}
.ef-tr:hover { background: #fafbff; }
.ef-tr.ef-tr-active { background: #eef2ff; }

.ef-td {
  padding: 4px 6px;
  vertical-align: middle;
}
.ef-td-idx { text-align: center; color: var(--ef-text-muted); font-size: 11px; }
.ef-td-num { text-align: right; }

/* Cell inputs */
.ef-cell-input {
  width: 100%;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 13px;
  color: var(--ef-text);
  background: transparent;
  font-family: var(--ef-font);
  box-sizing: border-box;
  transition: border-color .12s, background .12s;
}
.ef-cell-input:focus {
  outline: none;
  border-color: var(--ef-primary);
  background: #fff;
  box-shadow: 0 0 0 2px rgba(67,97,238,.12);
}
.ef-cell-input[readonly] {
  color: var(--ef-text-muted);
  cursor: default;
}
.ef-cell-input.ef-input-num { text-align: right; }

/* Autocomplete dropdown */
.ef-autocomplete {
  position: absolute;
  background: #fff;
  border: 1px solid var(--ef-border);
  border-radius: 6px;
  box-shadow: var(--ef-shadow-lg);
  z-index: 9999;
  min-width: 220px;
  max-height: 240px;
  overflow-y: auto;
  font-size: 13px;
}
.ef-autocomplete-item {
  padding: 7px 12px;
  cursor: pointer;
  transition: background .1s;
  border-bottom: 1px solid #f8fafc;
}
.ef-autocomplete-item:hover,
.ef-autocomplete-item.ef-ac-active {
  background: #eef2ff;
  color: var(--ef-primary);
}
.ef-autocomplete-item .ef-ac-desc {
  font-size: 11px;
  color: var(--ef-text-muted);
  display: block;
}
.ef-autocomplete-item.ef-ac-empty {
  color: var(--ef-text-muted);
  cursor: default;
  font-style: italic;
}

/* Delete button */
.ef-btn-del {
  background: none;
  border: none;
  color: #cbd5e1;
  cursor: pointer;
  font-size: 16px;
  padding: 2px 6px;
  border-radius: 4px;
  transition: color .15s, background .15s;
  line-height: 1;
}
.ef-btn-del:hover { color: var(--ef-danger); background: #fee2e2; }

/* Empty state */
.ef-empty-state {
  padding: 40px;
  text-align: center;
  color: var(--ef-text-muted);
}

/* Footer totals */
.ef-footer {
  background: var(--ef-card);
  border-top: 2px solid var(--ef-border);
  padding: 16px 20px;
}
.ef-footer-inner { display: flex; justify-content: flex-end; }
.ef-totals { min-width: 320px; }
.ef-total-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 0;
  border-bottom: 1px solid #f1f5f9;
}
.ef-total-row--grand {
  border-bottom: 2px solid var(--ef-border);
  padding: 8px 0;
  margin-top: 2px;
}
.ef-total-label { color: var(--ef-text-muted); font-size: 12px; font-weight: 500; }
.ef-total-value { font-family: "SF Mono", "Consolas", monospace; font-size: 14px; }
.ef-total-discount { color: var(--ef-danger); }
.ef-grand { font-size: 22px; font-weight: 700; color: var(--ef-primary); }
.ef-total-row--grand .ef-total-label { font-size: 14px; font-weight: 700; color: var(--ef-text); }
.ef-words-row { margin-top: 6px; }
.ef-words { font-size: 11px; color: var(--ef-text-muted); font-style: italic; }

/* ── Action Bar (flotante, persistente) ─────────────────────────── */
.ef-action-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 64px;
  background: #fff;
  border-top: 1px solid var(--ef-border);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 20px;
  z-index: 1050;
  box-shadow: 0 -4px 20px rgba(0,0,0,.08);
}

/* Buttons */
.ef-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  border-radius: 6px;
  padding: 9px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all .15s;
  font-family: var(--ef-font);
  white-space: nowrap;
}
.ef-btn:disabled {
  opacity: .38;
  cursor: not-allowed;
  pointer-events: none;
}
.ef-btn-sm { padding: 5px 12px; font-size: 12px; }

.ef-btn-primary   { background: var(--ef-primary); color: #fff; }
.ef-btn-primary:hover   { background: var(--ef-primary-dark); }

.ef-btn-success   { background: var(--ef-success); color: #fff; }
.ef-btn-success:hover   { background: #21a547; }

.ef-btn-warning   { background: var(--ef-warning); color: #fff; }
.ef-btn-warning:hover   { background: #e07e0c; }

.ef-btn-info      { background: var(--ef-info); color: #fff; }
.ef-btn-info:hover      { background: #29a8d4; }

.ef-btn-secondary { background: #f1f5f9; color: var(--ef-text); border: 1px solid var(--ef-border); }
.ef-btn-secondary:hover { background: #e2e8f0; }

.ef-btn-light     { background: #f8fafc; color: var(--ef-text); border: 1px solid var(--ef-border); }
.ef-btn-light:hover     { background: #e2e8f0; }

.ef-btn-danger    { background: var(--ef-danger); color: #fff; }
.ef-btn-danger:hover    { background: #c1121f; }

/* Spinner overlay */
.ef-loading-overlay {
  position: fixed;
  inset: 0;
  background: rgba(255,255,255,.5);
  z-index: 9998;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* FEL info badge in footer */
.ef-fel-info {
  margin-top: 10px;
  padding: 8px 12px;
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 6px;
  font-size: 11px;
  color: #166534;
  display: none;
}
.ef-fel-info.ef-visible { display: block; }

/* Responsive */
@media (max-width: 900px) {
  .ef-header-fields { grid-template-columns: 1fr 1fr; }
  .ef-field-col--wide { grid-column: span 2; }
  .ef-table { font-size: 12px; }
}
@media (max-width: 600px) {
  .ef-header-fields { grid-template-columns: 1fr; }
  .ef-field-col--wide { grid-column: 1; }
  .ef-action-bar { gap: 4px; padding: 0 10px; }
  .ef-btn { padding: 8px 10px; font-size: 12px; }
}
		`;
		$("<style>").attr("id", "ef-styles").html(css).appendTo("head");
	}

	// -----------------------------------------------------------------------
	// Header Controls (Frappe ControlLink)
	// -----------------------------------------------------------------------

	_setup_header_controls() {
		// Naming series <select>
		const $ns = this.$body.find("#ef-naming-series");
		const series = this.defaults.naming_series || ["SINV-.YYYY.-"];
		series.forEach((s) => $ns.append(`<option value="${s}">${s}</option>`));
		$ns.val(series[0] || "").on("change", () => {
			this.doc.naming_series = $ns.val();
		});

		// Link fields vía Frappe ControlLink
		this._make_link_ctrl("customer", "Customer", true);
		this._make_link_ctrl("payment_terms_template", "Payment Terms Template", false);
		this._make_link_ctrl("taxes_and_charges", "Sales Taxes and Charges Template", false);

		// Fecha de emisión
		this.$body.find("#ef-posting-date").on("change", (e) => {
			this.doc.posting_date = e.target.value;
		});

		// Fecha vencimiento
		this.$body.find("#ef-due-date").on("change", (e) => {
			this.doc.due_date = e.target.value;
		});

		// NIT
		this.$body.find("#ef-bfel-nit").on("change input", (e) => {
			this.doc.bfel_nit = e.target.value;
		});

		// bfel_status
		this.$body.find("#ef-bfel-status").on("change", (e) => {
			this.doc.bfel_status = e.target.value;
		});

		// Terms
		this.$body.find("#ef-terms").on("change input", (e) => {
			this.doc.terms = e.target.value;
		});
	}

	_make_link_ctrl(fieldname, options_doctype, required) {
		const $container = this.$body.find(`[data-ctrl="${fieldname}"]`);
		if (!$container.length) return;

		const ctrl = frappe.ui.form.make_control({
			parent: $container[0],
			df: {
				label: fieldname,
				fieldtype: "Link",
				fieldname: fieldname,
				options: options_doctype,
				reqd: required ? 1 : 0,
				in_list_view: 0,
			},
			render_input: true,
			only_input: false,
		});
		ctrl.refresh();
		this.controls[fieldname] = ctrl;

		// Escuchar cambios
		ctrl.$input.on("change", () => {
			const val = ctrl.get_value() || "";
			this.doc[fieldname] = val;
			if (fieldname === "customer") {
				this._on_customer_change(val);
			}
			if (fieldname === "taxes_and_charges") {
				this._on_taxes_change(val);
			}
		});
	}

	_on_customer_change(customer) {
		if (!customer) return;
		// Obtener NIT del cliente si existe el campo tax_id
		frappe.call({
			method: "frappe.client.get_value",
			args: {
				doctype: "Customer",
				filters: { name: customer },
				fieldname: ["tax_id", "payment_terms", "customer_name"],
			},
			callback: (r) => {
				if (!r.exc && r.message) {
					if (r.message.tax_id) {
						this.doc.bfel_nit = r.message.tax_id;
						this.$body.find("#ef-bfel-nit").val(r.message.tax_id);
					}
					if (r.message.payment_terms && !this.doc.payment_terms_template) {
						this.doc.payment_terms_template = r.message.payment_terms;
						if (this.controls.payment_terms_template) {
							this.controls.payment_terms_template.set_value(r.message.payment_terms);
						}
					}
				}
			},
		});
	}

	_on_taxes_change(tpl_name) {
		// Las taxes se recalculan en save() vía ERPNext, nada más que hacer aquí
		this.doc.taxes_and_charges = tpl_name;
	}

	// -----------------------------------------------------------------------
	// Items Table
	// -----------------------------------------------------------------------

	_setup_item_table() {
		this.$body.find("#ef-add-row").on("click", () => this._add_item_row());
	}

	_render_items() {
		const $tbody = this.$body.find("#ef-items-body");
		$tbody.empty();

		if (!this.doc.items || this.doc.items.length === 0) {
			this.$body.find("#ef-items-empty").show();
			return;
		}
		this.$body.find("#ef-items-empty").hide();

		this.doc.items.forEach((item, idx) => {
			$tbody.append(this._item_row_html(idx, item));
			this._bind_row_events(idx);
		});
	}

	_item_row_html(idx, item) {
		const amount = this._calc_amount(item.qty, item.rate, item.discount_percentage);
		return `
<tr class="ef-tr" data-idx="${idx}" id="ef-row-${idx}">
  <td class="ef-td ef-td-idx">${idx + 1}</td>
  <td class="ef-td">
    <div class="ef-ac-wrapper" style="position:relative">
      <input type="text" class="ef-cell-input ef-item-code"
        data-field="item_code" data-idx="${idx}"
        value="${_esc(item.item_code || "")}"
        placeholder="Código..." autocomplete="off" />
    </div>
  </td>
  <td class="ef-td">
    <input type="text" class="ef-cell-input ef-item-name"
      data-field="item_name" data-idx="${idx}"
      value="${_esc(item.item_name || "")}"
      placeholder="Nombre / Descripción" />
  </td>
  <td class="ef-td">
    <div class="ef-ac-wrapper" style="position:relative">
      <input type="text" class="ef-cell-input ef-warehouse"
        data-field="warehouse" data-idx="${idx}"
        value="${_esc(item.warehouse || "")}"
        placeholder="Almacén..." autocomplete="off" />
    </div>
  </td>
  <td class="ef-td ef-td-num">
    <input type="number" class="ef-cell-input ef-input-num ef-qty"
      data-field="qty" data-idx="${idx}"
      value="${item.qty || 1}" min="0" step="any" />
  </td>
  <td class="ef-td ef-td-num">
    <input type="number" class="ef-cell-input ef-input-num ef-rate"
      data-field="rate" data-idx="${idx}"
      value="${item.rate || 0}" min="0" step="any" />
  </td>
  <td class="ef-td ef-td-num">
    <input type="number" class="ef-cell-input ef-input-num ef-disc"
      data-field="discount_percentage" data-idx="${idx}"
      value="${item.discount_percentage || 0}" min="0" max="100" step="any" />
  </td>
  <td class="ef-td ef-td-num">
    <input type="text" class="ef-cell-input ef-input-num ef-amount"
      data-field="amount" data-idx="${idx}"
      value="${_fmt(amount)}" readonly />
  </td>
  <td class="ef-td">
    <div class="ef-ac-wrapper" style="position:relative">
      <input type="text" class="ef-cell-input ef-cost-center"
        data-field="cost_center" data-idx="${idx}"
        value="${_esc(item.cost_center || "")}"
        placeholder="Centro..." autocomplete="off" />
    </div>
  </td>
  <td class="ef-td">
    <button class="ef-btn-del ef-del-row" data-idx="${idx}" title="Eliminar fila">×</button>
  </td>
</tr>`;
	}

	_bind_row_events(idx) {
		const $row = this.$body.find(`#ef-row-${idx}`);

		// item_code → autocomplete + get_item_details
		const $itemCode = $row.find(".ef-item-code");
		this._setup_ac($itemCode, "Item", (value, label) => {
			this.doc.items[idx].item_code = value;
			this._fetch_item_details(idx, value);
		});

		// warehouse → autocomplete
		const $wh = $row.find(".ef-warehouse");
		this._setup_ac($wh, "Warehouse", (value) => {
			this.doc.items[idx].warehouse = value;
		});

		// cost_center → autocomplete
		const $cc = $row.find(".ef-cost-center");
		this._setup_ac($cc, "Cost Center", (value) => {
			this.doc.items[idx].cost_center = value;
		});

		// item_name
		$row.find(".ef-item-name").on("change input", (e) => {
			this.doc.items[idx].item_name = e.target.value;
		});

		// qty / rate / discount → recalcular amount local
		["qty", "rate", "discount_percentage"].forEach((field) => {
			$row.find(`[data-field="${field}"]`).on("input change", (e) => {
				const val = parseFloat(e.target.value) || 0;
				this.doc.items[idx][field] = val;
				this._update_row_amount(idx);
			});
		});

		// Delete row
		$row.find(".ef-del-row").on("click", () => this._remove_item_row(idx));

		// Highlight active row
		$row.on("focusin", () => {
			this.$body.find(".ef-tr").removeClass("ef-tr-active");
			$row.addClass("ef-tr-active");
		});

		// Tab key navigation en la última celda → nueva fila
		$row.find("input:last").on("keydown", (e) => {
			if (e.key === "Tab" && !e.shiftKey && idx === this.doc.items.length - 1) {
				e.preventDefault();
				this._add_item_row();
			}
		});
	}

	_add_item_row(item = {}) {
		const defaults = this.defaults;
		const row = {
			item_code: item.item_code || "",
			item_name: item.item_name || "",
			warehouse: item.warehouse || defaults.default_warehouse || "",
			qty: item.qty || 1,
			uom: item.uom || "",
			rate: item.rate || 0,
			discount_percentage: item.discount_percentage || 0,
			amount: item.amount || 0,
			cost_center: item.cost_center || defaults.default_cost_center || "",
			description: item.description || "",
		};
		this.doc.items.push(row);
		this._render_items();
		// Focus en el nuevo item_code
		const newIdx = this.doc.items.length - 1;
		this.$body.find(`#ef-row-${newIdx} .ef-item-code`).focus();
		this._update_local_footer();
	}

	_remove_item_row(idx) {
		this.doc.items.splice(idx, 1);
		this._render_items();
		this._update_local_footer();
	}

	_fetch_item_details(idx, item_code) {
		if (!item_code) return;
		frappe.call({
			method: "efast_sale.api.invoice.get_item_details",
			args: {
				item_code: item_code,
				company: this.doc.company || this.defaults.company || "",
				customer: this.doc.customer || "",
				warehouse: this.doc.items[idx].warehouse || this.defaults.default_warehouse || "",
			},
			callback: (r) => {
				if (!r.exc && r.message) {
					const d = r.message;
					const row = this.doc.items[idx];
					if (row) {
						row.item_name = d.item_name || row.item_name;
						row.rate = d.rate || row.rate;
						row.uom = d.uom || row.uom;
						if (!row.warehouse) row.warehouse = d.warehouse || "";
						if (!row.cost_center) row.cost_center = d.cost_center || "";
						row.description = d.description || "";
						row.amount = this._calc_amount(row.qty, row.rate, row.discount_percentage);
						this._render_items();
						this._update_local_footer();
						// Focus en qty
						this.$body.find(`#ef-row-${idx} .ef-qty`).focus().select();
					}
				}
			},
		});
	}

	_update_row_amount(idx) {
		const row = this.doc.items[idx];
		if (!row) return;
		row.amount = this._calc_amount(row.qty, row.rate, row.discount_percentage);
		this.$body.find(`#ef-row-${idx} .ef-amount`).val(_fmt(row.amount));
		this._update_local_footer();
	}

	_calc_amount(qty, rate, disc) {
		qty = parseFloat(qty) || 0;
		rate = parseFloat(rate) || 0;
		disc = parseFloat(disc) || 0;
		const base = qty * rate;
		return base - (base * disc) / 100;
	}

	// -----------------------------------------------------------------------
	// Lightweight Autocomplete (sin deps externas)
	// -----------------------------------------------------------------------

	_setup_ac($input, doctype, onSelect) {
		let $dropdown = null;
		let _timer = null;
		let _results = [];
		let _active = -1;

		const close = () => {
			if ($dropdown) { $dropdown.remove(); $dropdown = null; }
			_active = -1;
		};

		const open = (results) => {
			close();
			if (!results.length) {
				$dropdown = $(`<div class="ef-autocomplete"><div class="ef-autocomplete-item ef-ac-empty">Sin resultados</div></div>`);
			} else {
				_results = results;
				const items = results
					.map((r, i) => `<div class="ef-autocomplete-item" data-i="${i}">
						${_esc(r.label || r.value)}
						${r.description ? `<span class="ef-ac-desc">${_esc(r.description)}</span>` : ""}
					</div>`)
					.join("");
				$dropdown = $(`<div class="ef-autocomplete">${items}</div>`);
			}

			const offset = $input.offset();
			const inputH = $input.outerHeight();
			$dropdown.css({
				top: offset.top + inputH + 2,
				left: offset.left,
				width: Math.max(240, $input.outerWidth()),
			});
			$("body").append($dropdown);

			$dropdown.on("mousedown", ".ef-autocomplete-item:not(.ef-ac-empty)", (e) => {
				const i = parseInt($(e.currentTarget).data("i"));
				const r = _results[i];
				$input.val(r.label || r.value);
				onSelect(r.value, r.label);
				close();
			});
		};

		const highlight = (dir) => {
			if (!$dropdown) return;
			const $items = $dropdown.find(".ef-autocomplete-item:not(.ef-ac-empty)");
			$items.removeClass("ef-ac-active");
			_active = Math.max(0, Math.min(_active + dir, $items.length - 1));
			$items.eq(_active).addClass("ef-ac-active");
		};

		$input.on("input", () => {
			const txt = $input.val().trim();
			clearTimeout(_timer);
			if (txt.length < 1) { close(); return; }
			_timer = setTimeout(() => {
				frappe.call({
					method: "frappe.desk.search.search_link",
					args: {
						txt: txt,
						doctype: doctype,
						ignore_user_permissions: 0,
						reference_doctype: "Sales Invoice",
					},
					callback: (r) => {
						open(r.results || []);
					},
				});
			}, 180);
		});

		$input.on("keydown", (e) => {
			if (!$dropdown) return;
			if (e.key === "ArrowDown") { e.preventDefault(); highlight(1); }
			else if (e.key === "ArrowUp") { e.preventDefault(); highlight(-1); }
			else if (e.key === "Enter") {
				e.preventDefault();
				const $active = $dropdown.find(".ef-ac-active");
				if ($active.length) {
					const i = parseInt($active.data("i"));
					const r = _results[i];
					$input.val(r.label || r.value);
					onSelect(r.value, r.label);
				}
				close();
			} else if (e.key === "Escape") {
				close();
			}
		});

		$input.on("blur", () => setTimeout(close, 180));
	}

	// -----------------------------------------------------------------------
	// Footer Totals
	// -----------------------------------------------------------------------

	_update_local_footer() {
		// Calcula localmente desde items (antes del save)
		let subtotal = 0;
		(this.doc.items || []).forEach((r) => {
			subtotal += parseFloat(r.amount) || 0;
		});
		const taxes = parseFloat(this.doc.total_taxes_and_charges) || 0;
		const discounts = parseFloat(this.doc.discount_amount) || 0;
		const grand = subtotal + taxes - discounts;

		this.$body.find("#ef-subtotal").text(_fmtCurrency(subtotal, this.doc.currency));
		this.$body.find("#ef-discounts").text("- " + _fmtCurrency(discounts, this.doc.currency));
		this.$body.find("#ef-taxes").text(_fmtCurrency(taxes, this.doc.currency));
		this.$body.find("#ef-grand-total").text(_fmtCurrency(grand, this.doc.currency));
	}

	_update_footer() {
		// Actualiza desde doc (post-save, datos reales de ERPNext)
		const d = this.doc;
		this.$body.find("#ef-subtotal").text(_fmtCurrency(d.total, d.currency));
		this.$body.find("#ef-discounts").text("- " + _fmtCurrency(d.discount_amount, d.currency));
		this.$body.find("#ef-taxes").text(_fmtCurrency(d.total_taxes_and_charges, d.currency));
		this.$body.find("#ef-grand-total").text(_fmtCurrency(d.grand_total, d.currency));
		this.$body.find("#ef-words").text(d.in_words || "");
	}

	// -----------------------------------------------------------------------
	// Sync UI ← Doc
	// -----------------------------------------------------------------------

	_sync_ui_from_doc() {
		const d = this.doc;

		// naming_series
		this.$body.find("#ef-naming-series").val(d.naming_series || "");

		// Link controls
		["customer", "payment_terms_template", "taxes_and_charges"].forEach((f) => {
			if (this.controls[f]) {
				this.controls[f].set_value(d[f] || "");
			}
		});

		// Dates
		this.$body.find("#ef-posting-date").val(d.posting_date || "");
		this.$body.find("#ef-due-date").val(d.due_date || "");

		// Text fields
		this.$body.find("#ef-bfel-nit").val(d.bfel_nit || "");
		this.$body.find("#ef-bfel-status").val(d.bfel_status || "01 Enviar");
		this.$body.find("#ef-terms").val(d.terms || "");

		// Items
		this._render_items();

		// Footer
		this._update_footer();

		// Status badge
		this._update_status_badge();

		// FEL info
		this._update_fel_info();
	}

	_update_status_badge() {
		const $badge = this.$body.find("#ef-status-badge");
		const $name = this.$body.find("#ef-doc-name");
		const d = this.doc;

		$name.text(d.name !== "new" ? d.name : "");

		if (d.name === "new" || !d.name) {
			$badge.text("NUEVO").removeClass().addClass("ef-badge ef-badge-new");
		} else if (d.docstatus === 0) {
			$badge.text("BORRADOR").removeClass().addClass("ef-badge ef-badge-draft");
		} else if (d.docstatus === 1) {
			const fel = d.bfel_status;
			if (fel === "02 Procesada") {
				$badge.text("CERTIFICADO").removeClass().addClass("ef-badge ef-badge-certified");
			} else {
				$badge.text("VALIDADO").removeClass().addClass("ef-badge ef-badge-submitted");
			}
		} else if (d.docstatus === 2) {
			$badge.text("CANCELADO").removeClass().addClass("ef-badge ef-badge-cancelled");
		}
	}

	_update_fel_info() {
		// Mostrar info FEL si ya está certificado (puede extenderse)
		const d = this.doc;
		if (d.bfel_uuid) {
			const $fi = this.$body.find(".ef-fel-info");
			if (!$fi.length) return;
			$fi.html(`FEL Certificado — UUID: <strong>${d.bfel_uuid}</strong>`).addClass("ef-visible");
		}
	}

	// -----------------------------------------------------------------------
	// Action Bar
	// -----------------------------------------------------------------------

	_setup_action_bar() {
		const $bar = $(`
<div class="ef-action-bar" id="ef-action-bar">
  <button id="ef-btn-save"    class="ef-btn ef-btn-primary"   title="Guardar borrador (Ctrl+S)">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
    Guardar
  </button>
  <button id="ef-btn-submit"  class="ef-btn ef-btn-success"   title="Validar factura (Ctrl+V)">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
    Validar
  </button>
  <button id="ef-btn-certify" class="ef-btn ef-btn-warning"   title="Certificar FEL (Ctrl+F)">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
    Certificar
  </button>
  <button id="ef-btn-print"   class="ef-btn ef-btn-info"      title="Imprimir (Ctrl+P)">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
    Imprimir
  </button>
  <button id="ef-btn-email"   class="ef-btn ef-btn-secondary" title="Enviar por Email">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
    Email
  </button>
  <button id="ef-btn-new"     class="ef-btn ef-btn-light"     title="Nueva Factura (Ctrl+N)">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    Nuevo
  </button>
  <button id="ef-btn-open-erp" class="ef-btn ef-btn-light"   title="Abrir en ERPNext">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
    Abrir ERP
  </button>
</div>`);
		$("body").append($bar);

		// Events
		$bar.find("#ef-btn-save").on("click", () => this._action_save());
		$bar.find("#ef-btn-submit").on("click", () => this._action_submit());
		$bar.find("#ef-btn-certify").on("click", () => this._action_certify());
		$bar.find("#ef-btn-print").on("click", () => this._action_print());
		$bar.find("#ef-btn-email").on("click", () => this._action_email());
		$bar.find("#ef-btn-new").on("click", () => this._action_new());
		$bar.find("#ef-btn-open-erp").on("click", () => this._action_open_erp());

		this.$bar = $bar;
		this._update_action_bar_state();
	}

	_update_action_bar_state() {
		const d = this.doc;
		const isNew = d.name === "new" || !d.name;
		const isDraft = d.docstatus === 0 && !isNew;
		const isSubmitted = d.docstatus === 1;
		const isCertified = isSubmitted && d.bfel_status === "02 Procesada";
		const isCancelled = d.docstatus === 2;

		const btn = (id) => this.$bar && this.$bar.find(id);

		btn("#ef-btn-save").prop("disabled", isSubmitted || isCancelled);
		btn("#ef-btn-submit").prop("disabled", isNew || isSubmitted || isCancelled);
		btn("#ef-btn-certify").prop("disabled", !isSubmitted || isCertified || isCancelled);
		btn("#ef-btn-print").prop("disabled", isNew);
		btn("#ef-btn-email").prop("disabled", isNew);
		btn("#ef-btn-open-erp").prop("disabled", isNew);
	}

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	_action_save() {
		if (!this._validate_header()) return;

		frappe.call({
			method: "efast_sale.api.invoice.save_draft",
			args: { doc_json: JSON.stringify(this._build_save_payload()) },
			freeze: true,
			freeze_message: "Guardando factura...",
			callback: (r) => {
				if (!r.exc && r.message) {
					this.doc = r.message;
					this._sync_ui_from_doc();
					this._update_action_bar_state();
					frappe.show_alert({
						message: `Guardado: <strong>${this.doc.name}</strong>`,
						indicator: "green",
					});
				}
			},
		});
	}

	_action_submit() {
		if (!this.doc.name || this.doc.name === "new") {
			frappe.show_alert({ message: "Primero guarde la factura.", indicator: "orange" });
			return;
		}

		frappe.confirm(
			`¿Desea <strong>Validar</strong> la factura <strong>${this.doc.name}</strong>?<br>
			 Esta acción no se puede deshacer directamente.`,
			() => {
				frappe.call({
					method: "efast_sale.api.invoice.submit_invoice",
					args: { name: this.doc.name },
					freeze: true,
					freeze_message: "Validando factura...",
					callback: (r) => {
						if (!r.exc && r.message) {
							// Recargar doc completo
							this.load_invoice(this.doc.name);
							frappe.show_alert({
								message: `Factura <strong>${this.doc.name}</strong> validada.`,
								indicator: "green",
							});
						}
					},
				});
			}
		);
	}

	_action_certify() {
		if (!this.doc.name || this.doc.docstatus !== 1) {
			frappe.show_alert({ message: "Solo se puede certificar una factura Validada.", indicator: "orange" });
			return;
		}
		if (this.doc.bfel_status === "02 Procesada") {
			frappe.show_alert({ message: "Esta factura ya fue certificada en FEL.", indicator: "blue" });
			return;
		}

		frappe.confirm(
			`¿Certificar <strong>${this.doc.name}</strong> en FEL (Digifact)?`,
			() => {
				frappe.call({
					method: "efast_sale.api.invoice.certify_invoice",
					args: { name: this.doc.name },
					freeze: true,
					freeze_message: "Certificando en FEL...",
					callback: (r) => {
						if (!r.exc && r.message && r.message.success) {
							const res = r.message;
							frappe.msgprint({
								title: "Certificación FEL Exitosa",
								indicator: "green",
								message: `UUID: <strong>${res.uuid || "-"}</strong><br>
								          Serie: ${res.serie || "-"} &nbsp; No.: ${res.numero || "-"}<br>
								          ${res.test_mode ? "<em>(MODO PRUEBA)</em>" : ""}`,
							});
							// Recargar doc
							this.load_invoice(this.doc.name);
						}
					},
				});
			}
		);
	}

	_action_print() {
		if (!this.doc.name || this.doc.name === "new") return;
		const url = `/printview?doctype=Sales+Invoice&name=${encodeURIComponent(this.doc.name)}&trigger_print=1`;
		window.open(url, "_blank");
	}

	_action_email() {
		if (!this.doc.name || this.doc.name === "new") return;
		// Usar el dialog de email estándar de Frappe
		new frappe.views.CommunicationComposer({
			doc: { doctype: "Sales Invoice", name: this.doc.name },
			subject: `Factura ${this.doc.name}`,
			recipients: "",
			frm: { doc: { doctype: "Sales Invoice", name: this.doc.name } },
		});
	}

	_action_new() {
		if (this.doc.docstatus === 0 && this.doc.name !== "new" && this.doc.name) {
			frappe.confirm(
				"¿Crear nueva factura? Los cambios no guardados se perderán.",
				() => this._new_invoice()
			);
		} else {
			this._new_invoice();
		}
	}

	_action_open_erp() {
		if (!this.doc.name || this.doc.name === "new") return;
		const url = `/app/sales-invoice/${encodeURIComponent(this.doc.name)}`;
		window.open(url, "_blank");
	}

	// -----------------------------------------------------------------------
	// Load existing invoice
	// -----------------------------------------------------------------------

	load_invoice(name) {
		frappe.call({
			method: "efast_sale.api.invoice.get_invoice",
			args: { name: name },
			freeze: true,
			freeze_message: "Cargando factura...",
			callback: (r) => {
				if (!r.exc && r.message) {
					this.doc = r.message;
					this._sync_ui_from_doc();
					this._update_action_bar_state();
					frappe.show_alert({
						message: `Cargado: <strong>${this.doc.name}</strong>`,
						indicator: "blue",
					});
				}
			},
		});
	}

	// -----------------------------------------------------------------------
	// Keyboard Shortcuts
	// -----------------------------------------------------------------------

	_bind_events() {
		$(document).off("keydown.efast").on("keydown.efast", (e) => {
			if (!$(e.target).closest(".ef-wrapper, .ef-action-bar").length &&
				!$(e.target).is("body")) return;

			if ((e.ctrlKey || e.metaKey) && e.key === "s") {
				e.preventDefault();
				this._action_save();
			} else if ((e.ctrlKey || e.metaKey) && e.key === "n") {
				e.preventDefault();
				this._action_new();
			} else if (e.key === "F2") {
				e.preventDefault();
				this._add_item_row();
			}
		});
	}

	// -----------------------------------------------------------------------
	// Validation
	// -----------------------------------------------------------------------

	_validate_header() {
		if (!this.doc.customer) {
			frappe.show_alert({ message: "El campo <strong>Cliente</strong> es obligatorio.", indicator: "red" });
			if (this.controls.customer) this.controls.customer.$input.focus();
			return false;
		}
		if (!this.doc.posting_date) {
			frappe.show_alert({ message: "La <strong>Fecha de Emisión</strong> es obligatoria.", indicator: "red" });
			this.$body.find("#ef-posting-date").focus();
			return false;
		}
		if (!this.doc.items || this.doc.items.length === 0) {
			frappe.show_alert({ message: "Agregue al menos un <strong>ítem</strong> a la factura.", indicator: "red" });
			this.$body.find("#ef-add-row").focus();
			return false;
		}
		return true;
	}

	// -----------------------------------------------------------------------
	// Build payload for save
	// -----------------------------------------------------------------------

	_build_save_payload() {
		// Construir el dict limpio para enviar al backend
		const d = this.doc;
		return {
			doctype: "Sales Invoice",
			name: d.name !== "new" ? d.name : undefined,
			naming_series: d.naming_series,
			customer: d.customer,
			company: d.company || this.defaults.company || "",
			posting_date: d.posting_date,
			due_date: d.due_date,
			payment_terms_template: d.payment_terms_template || "",
			terms: d.terms || "",
			taxes_and_charges: d.taxes_and_charges || "",
			bfel_nit: d.bfel_nit || "",
			bfel_status: d.bfel_status || "01 Enviar",
			items: (d.items || []).map((r) => ({
				item_code: r.item_code,
				item_name: r.item_name || "",
				description: r.description || r.item_name || "",
				warehouse: r.warehouse || "",
				qty: parseFloat(r.qty) || 1,
				uom: r.uom || "",
				rate: parseFloat(r.rate) || 0,
				discount_percentage: parseFloat(r.discount_percentage) || 0,
				cost_center: r.cost_center || "",
			})).filter((r) => r.item_code),
		};
	}

	// -----------------------------------------------------------------------
	// Focus helpers
	// -----------------------------------------------------------------------

	_focus_first_field() {
		setTimeout(() => {
			if (this.controls.customer) {
				this.controls.customer.$input.focus();
			}
		}, 100);
	}
}

// ---------------------------------------------------------------------------
// Utility functions (module-level, no side effects)
// ---------------------------------------------------------------------------

function _esc(str) {
	return String(str || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function _fmt(n) {
	return parseFloat(n || 0).toFixed(2);
}

function _fmtCurrency(n, currency) {
	const symbol = currency === "GTQ" ? "Q" : (currency || "Q");
	return `${symbol} ${parseFloat(n || 0).toLocaleString("es-GT", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}
