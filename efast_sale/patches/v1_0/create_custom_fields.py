"""
Patch: crea custom fields en Sales Invoice para el módulo de pagos eFast.
Idempotente — se puede correr múltiples veces sin efecto secundario.
"""
import frappe


def execute():
    _create_if_missing(
        dt="Sales Invoice",
        fieldname="custom_pagado",
        label="Pagado",
        fieldtype="Check",
        default="0",
        insert_after="outstanding_amount",
    )
    _create_if_missing(
        dt="Sales Invoice",
        fieldname="custom_efast_payments",
        label="Pagos eFast",
        fieldtype="Table",
        options="eFast Invoice Payment",
        insert_after="custom_pagado",
    )
    frappe.db.commit()


def _create_if_missing(**kwargs):
    dt = kwargs["dt"]
    fieldname = kwargs["fieldname"]
    if frappe.db.exists("Custom Field", {"dt": dt, "fieldname": fieldname}):
        return
    doc = frappe.new_doc("Custom Field")
    for k, v in kwargs.items():
        setattr(doc, k, v)
    doc.module = "eFast Sale"
    doc.insert(ignore_permissions=True)
