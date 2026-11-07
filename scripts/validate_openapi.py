#!/usr/bin/env python3
"""MeetWise targeted, reproducible OpenAPI 3.1 structural checker.

NOT a replacement for Redocly/openapi-spec-validator, schema-runtime compatibility,
or NestJS controller conformance. Requirements: pip install pyyaml jsonschema.
No I/O beyond reading the file supplied; no network calls.
"""
from __future__ import annotations
import argparse
import collections
import json
import pathlib
import re
import sys
import urllib.parse
import yaml
from jsonschema import Draft202012Validator

METHODS = {"get", "post", "put", "patch", "delete", "head", "options", "trace"}
ROUTE_PARAM = re.compile(r"\{([^{}]+)\}")

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("contract", type=pathlib.Path)
    a = ap.parse_args()
    doc = yaml.safe_load(a.contract.read_text(encoding="utf-8"))
    errors: list[str] = []
    if not isinstance(doc, dict) or not str(doc.get("openapi", "")).startswith("3.1."):
        errors.append("Root must contain OpenAPI 3.1.x")
    paths = doc.get("paths", {})
    if not isinstance(paths, dict):
        errors.append("paths must be an object")
        paths = {}
    operation_ids = []
    ops = 0
    for path, item in paths.items():
        if not isinstance(item, dict):
            errors.append(f"{path}: path item is not an object")
            continue
        common_params = item.get("parameters", [])
        for meth, operation in item.items():
            if meth not in METHODS:
                continue
            ops += 1
            where = f"{meth.upper()} {path}"
            if not isinstance(operation, dict):
                errors.append(f"{where}: missing operation object")
                continue
            ident = operation.get("operationId")
            if not isinstance(ident, str) or not ident.strip():
                errors.append(f"{where}: operationId required")
            else:
                operation_ids.append(ident)
            responses = operation.get("responses")
            if not isinstance(responses, dict) or not responses:
                errors.append(f"{where}: responses required")
            route_params = set(ROUTE_PARAM.findall(path))
            params = common_params + operation.get("parameters", [])
            defined_params = set()
            for p in params:
                if "$ref" in p:

                    continue
                if p.get("in") == "path":
                    defined_params.add(p.get("name"))
                    if not p.get("required"):
                        errors.append(f"{where}: path param {p.get('name')} not required")
            if route_params != defined_params:
                errors.append(f"{where}: path params {sorted(route_params)} vs declared {sorted(defined_params)}")
    duplicates = [k for k,v in collections.Counter(operation_ids).items() if v > 1]
    if duplicates:
        errors.append(f"Duplicate operationIds: {duplicates}")


    def walk(node, location="root"):
        if isinstance(node, dict):
            for k,v in node.items():
                if k == "$ref":
                    if not isinstance(v, str) or not v.startswith("#/"):
                        errors.append(f"{location}: unsupported $ref {v}")
                    else:
                        current = doc
                        try:
                            for seg in v[2:].split("/"):
                                seg = urllib.parse.unquote(seg.replace("~1", "/").replace("~0", "~"))
                                current = current[seg]
                        except (KeyError, TypeError, IndexError):
                            errors.append(f"{location}: unresolved {v}")
                else:
                    walk(v, f"{location}/{k}")
        elif isinstance(node, list):
            for i,v in enumerate(node):
                walk(v, f"{location}/{i}")
    walk(doc)
    schemas = doc.get("components", {}).get("schemas", {})
    for name, schema in schemas.items():
        try:
            Draft202012Validator.check_schema(schema)
        except Exception as exc:
            errors.append(f"Schema {name}: {type(exc).__name__}: {str(exc)[:180]}")


    routeschema = schemas.get("ApprovalRoute", {}).get("properties", {}).get("operation", {})
    allowed = routeschema.get("enum")
    if allowed != ["CREATE", "UPDATE_EXISTING"]:
        errors.append(f"ApprovalRoute.operation must exclude LINK_EXISTING/CREATE_ANOTHER: {allowed}")
    webhook = paths.get("/webhooks/vexa", {}).get("post", {})
    if webhook.get("security") != []:
        errors.append("Vexa webhook must have explicit security: [] and app-level signature guard before any deployment")
    if "requestBody" not in webhook:
        errors.append("Vexa webhook requestBody missing")
    if "post" not in paths.get("/users", {}) or "post" not in paths.get("/users/invitations", {}):
        errors.append("User local creation / SMTP invitation routes missing")
    print(json.dumps({"file":a.contract.name, "openapi":doc.get("openapi"),"paths":len(paths),"operations":ops,
                      "uniqueOperationIds":len(set(operation_ids)), "componentSchemas":len(schemas),
                      "errors":errors, "status":"PASS_TARGETED" if not errors else "FAIL"}, indent=2))
    return 1 if errors else 0

if __name__ == "__main__":
    sys.exit(main())
