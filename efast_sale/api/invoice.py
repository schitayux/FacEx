"""
efast_sale.api.invoice
----------------------
Thin wrapper sobre ERPNext Sales Invoice estándar.
NUNCA duplica lógica fiscal, de stock ni contable.
Toda la lógica real permanece en ERPNext core.
"""
from __future__ import annotations

import frappe
import json
from frappe.utils import today, add_days


# ---------------------------------------------------------------------------
# Permisos
# ---------------------------------------------------------------------------

def has_efast_permission():
    roles = frappe.get_roles()
    allowed = {"Sales User", "Accounts User", "Sales Manager",
                "Accounts Manager", "System Manager"}
    return bool(allowed & set(roles))


# ---------------------------------------------------------------------------
# 1. Defaults para nueva factura
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_defaults():
    """
    Retorna valores por defecto para inicializar una nueva factura:
    naming_series, company, warehouse, cost_center, currency, taxes_and_charges.
    """
    defaults = frappe.defaults.get_defaults()
    company = defaults.get("company") or frappe.db.get_single_value(
        "Global Defaults", "default_currency"
    )

    # Empresa por defecto del usuario
    company = (
        frappe.defaults.get_user_default("Company")
        or frappe.db.get_single_value("Global Defaults", "default_company")
        or ""
    )

    # Naming series disponibles para Sales Invoice
    naming_series = _get_naming_series("Sales Invoice")

    # Almacén por defecto
    default_warehouse = (
        frappe.defaults.get_user_default("Warehouse")
        or frappe.db.get_value("Warehouse",
            {"company": company, "is_group": 0, "disabled": 0},
            "name")
        or ""
    )

    # Centro de costo por defecto
    default_cost_center = (
        frappe.defaults.get_user_default("Cost Center")
        or frappe.db.get_value("Cost Center",
            {"company": company, "is_group": 0, "disabled": 0},
            "name")
        or ""
    )

    # Plantilla de impuestos por defecto
    default_taxes = (
        frappe.db.get_value("Sales Taxes and Charges Template",
            {"company": company, "is_default": 1},
            "name")
        or frappe.db.get_value("Sales Taxes and Charges Template",
            {"company": company, "disabled": 0},
            "name",
            order_by="creation asc")
        or ""
    )

    # Moneda de la empresa
    currency = frappe.db.get_value("Company", company, "default_currency") or "GTQ"

    return {
        "company": company,
        "naming_series": naming_series,
        "default_warehouse": default_warehouse,
        "default_cost_center": default_cost_center,
        "default_taxes_and_charges": default_taxes,
        "currency": currency,
        "posting_date": today(),
        "due_date": today(),
        "bfel_status_options": ["01 Enviar", "00 No enviar"],
        "bfel_status_default": "01 Enviar",
    }


def _get_naming_series(doctype: str) -> list:
    """
    Extrae naming series disponibles para un DocType.
    Prioridad: Property Setter > DocField > fallback.
    """
    try:
        # 1) Property Setter tiene máxima prioridad (personalización del usuario)
        prop = frappe.db.get_value(
            "Property Setter",
            {"doc_type": doctype, "field_name": "naming_series", "property": "options"},
            "value",
        )
        if prop:
            return [s.strip() for s in prop.split("\n") if s.strip()]

        # 2) DocField original
        options_str = frappe.db.get_value(
            "DocField",
            {"parent": doctype, "fieldname": "naming_series"},
            "options",
        ) or ""
        if options_str:
            return [s.strip() for s in options_str.split("\n") if s.strip()]

    except Exception:
        frappe.log_error(frappe.get_traceback(), "eFast Sale: get_naming_series")

    return ["SINV-.YYYY.-"]


# ---------------------------------------------------------------------------
# 2. Detalles de item
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_item_details(item_code: str, company: str = "", customer: str = "",
                     warehouse: str = "", posting_date: str = ""):
    """
    Retorna datos básicos de un item para poblar una fila del grid.
    No duplica la lógica de pricing — el precio final lo calcula ERPNext en save().
    """
    if not item_code:
        return {}

    item = frappe.get_cached_doc("Item", item_code)

    # Precio estándar (si existe)
    rate = 0.0
    price_list = (
        frappe.defaults.get_user_default("selling_price_list")
        or frappe.db.get_single_value("Selling Settings", "selling_price_list")
        or "Standard Selling"
    )
    item_price = frappe.db.get_value(
        "Item Price",
        {
            "item_code": item_code,
            "price_list": price_list,
            "selling": 1,
        },
        "price_list_rate",
        order_by="valid_from desc",
    )
    if item_price:
        rate = float(item_price)

    # Almacén por defecto del item o el pasado como parámetro
    item_warehouse = (
        warehouse
        or (item.item_defaults[0].default_warehouse if item.item_defaults else "")
        or frappe.db.get_value("Warehouse",
            {"company": company or "", "is_group": 0, "disabled": 0}, "name")
        or ""
    )

    # Centro de costo por defecto del item
    item_cost_center = (
        (item.item_defaults[0].buying_cost_center if item.item_defaults else "")
        or (item.item_defaults[0].expense_account if item.item_defaults else "")
        or ""
    )

    return {
        "item_code": item.name,
        "item_name": item.item_name,
        "description": item.description or item.item_name,
        "uom": item.stock_uom,
        "stock_uom": item.stock_uom,
        "rate": rate,
        "warehouse": item_warehouse,
        "cost_center": item_cost_center,
        "is_stock_item": item.is_stock_item,
    }


# ---------------------------------------------------------------------------
# 3. Guardar borrador
# ---------------------------------------------------------------------------

@frappe.whitelist()
def save_draft(doc_json: str):
    """
    Crea o actualiza un Sales Invoice en estado borrador.
    Toda la lógica de impuestos y totales la ejecuta ERPNext en doc.save().
    Retorna el documento completo con totales calculados.
    """
    data = frappe.parse_json(doc_json)
    name = (data.get("name") or "").strip()
    is_new = not name or name == "new"

    if is_new:
        data.pop("name", None)
        data["doctype"] = "Sales Invoice"
        doc = frappe.get_doc(data)
    else:
        # Verificar que el doc existe y está en borrador
        docstatus = frappe.db.get_value("Sales Invoice", name, "docstatus")
        if docstatus is None:
            frappe.throw(f"Factura {name} no existe.")
        if docstatus == 1:
            frappe.throw(
                "La factura ya fue validada (submitted). "
                "No se puede editar en este estado."
            )
        if docstatus == 2:
            frappe.throw("La factura está cancelada.")

        doc = frappe.get_doc("Sales Invoice", name)
        # Actualizar campos del encabezado
        for field in (
            "naming_series", "customer", "posting_date", "due_date",
            "payment_terms_template", "terms", "taxes_and_charges",
            "bfel_nit", "bfel_status", "company",
        ):
            if field in data:
                setattr(doc, field, data[field])

        # Reconstruir tabla de items desde el payload
        if "items" in data:
            doc.items = []
            for item_row in data["items"]:
                item_row.pop("name", None)  # forzar nueva row
                doc.append("items", item_row)

        # Reconstruir taxes si se envían
        if "taxes" in data and data["taxes"] is not None:
            # Solo reemplazar si se envió explícitamente el array
            pass  # Las taxes se recalculan desde taxes_and_charges en set_missing_values

    doc.flags.ignore_permissions = False
    doc.save()
    frappe.db.commit()

    return _safe_doc_dict(doc)


# ---------------------------------------------------------------------------
# 4. Validar (submit)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def submit_invoice(name: str):
    """
    Valida (submit) un Sales Invoice borrador.
    ERPNext ejecuta toda la lógica contable y de stock.
    """
    name = (name or "").strip()
    doc = frappe.get_doc("Sales Invoice", name)

    if doc.docstatus != 0:
        frappe.throw("Solo se puede validar una factura en estado Borrador.")

    doc.submit()
    frappe.db.commit()

    return {
        "success": True,
        "name": doc.name,
        "status": doc.status,
        "docstatus": doc.docstatus,
        "grand_total": doc.grand_total,
    }


# ---------------------------------------------------------------------------
# 5. Certificar FEL (delega 100% a brainfel)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def certify_invoice(name: str):
    """
    Certifica la factura vía Digifact/Brainfel.
    Delega completamente a brainfel.api.certify_sales_invoice.
    Sin duplicar absolutamente ninguna lógica FEL aquí.
    """
    from brainfel.api.certify_sales_invoice import certify_sales_invoice
    return certify_sales_invoice(name)


# ---------------------------------------------------------------------------
# 6. Cargar factura existente
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_invoice(name: str):
    """
    Carga una Sales Invoice existente para visualizar/editar en eFast Sale.
    """
    name = (name or "").strip()
    doc = frappe.get_doc("Sales Invoice", name)
    # Validar permiso de lectura (frappe lo maneja via get_doc)
    return _safe_doc_dict(doc)


# ---------------------------------------------------------------------------
# 7. Enviar email
# ---------------------------------------------------------------------------

@frappe.whitelist()
def send_invoice_email(name: str, recipients: str = "", print_format: str = ""):
    """
    Envía la factura por email usando el mecanismo estándar de ERPNext.
    """
    name = (name or "").strip()
    doc = frappe.get_doc("Sales Invoice", name)

    if not recipients:
        # Intentar obtener email del cliente
        recipients = frappe.db.get_value("Customer", doc.customer, "email_id") or ""

    if not recipients:
        frappe.throw("No se encontró dirección de email del cliente.")

    # Usar el mecanismo estándar de Frappe para enviar documento
    frappe.sendmail(
        recipients=recipients.split(","),
        subject=f"Factura {name}",
        message=f"Adjunto encontrará la factura {name}.",
        reference_doctype="Sales Invoice",
        reference_name=name,
    )
    return {"success": True, "sent_to": recipients}


# ---------------------------------------------------------------------------
# 8. Print formats disponibles
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_print_formats():
    """Retorna print formats disponibles para Sales Invoice."""
    formats = frappe.db.get_all(
        "Print Format",
        filters={"doc_type": "Sales Invoice", "disabled": 0},
        fields=["name"],
        order_by="name asc",
    )
    return [f["name"] for f in formats]


# ---------------------------------------------------------------------------
# Helper interno
# ---------------------------------------------------------------------------

def _safe_doc_dict(doc) -> dict:
    """Convierte doc a dict serializable con campos clave garantizados."""
    d = doc.as_dict()
    # Asegurar que campos numéricos no sean None
    for field in ("total", "total_taxes_and_charges", "discount_amount",
                  "grand_total", "outstanding_amount"):
        if d.get(field) is None:
            d[field] = 0.0
    return d
