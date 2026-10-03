#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CaffNap 饮品数据库构建脚本
用法:  python build_db.py            # 读取 beverages_source.xlsx → 输出 ../beverages.json
       python build_db.py --check   # 仅校验，不输出
"""
import sys, json, datetime
import pandas as pd

REQUIRED = ["key", "brand", "category", "drink", "spec", "mg_min", "mg_max",
            "source", "confidence", "collected"]
VALID_SOURCE = {"official", "lab_test", "estimate"}
VALID_CONF = {"high", "medium", "low"}

def validate(df):
    errors = []
    for col in REQUIRED:
        if col not in df.columns:
            errors.append(f"缺少必需列: {col}")
    if errors: return errors
    seen = set()
    for i, row in df.iterrows():
        k = row["key"]
        if not isinstance(k, str) or not k: errors.append(f"第{i+2}行 key 非法")
        if k in seen: errors.append(f"key 重复: {k}")
        seen.add(k)
        if row["source"] not in VALID_SOURCE: errors.append(f"{k}: source={row['source']} 非法")
        if row["confidence"] not in VALID_CONF: errors.append(f"{k}: confidence 非法")
        lo, hi = row["mg_min"], row["mg_max"]
        if pd.isna(lo) or pd.isna(hi): errors.append(f"{k}: 咖啡因区间不能为空")
        elif lo < 0 or hi < lo: errors.append(f"{k}: 区间非法 [{lo},{hi}]")
    return errors

def main():
    df = pd.read_excel("beverages_source.xlsx", sheet_name="beverages")
    errors = validate(df)
    if errors:
        print("校验失败:"); [print("  ✗", e) for e in errors]; sys.exit(1)
    items = []
    for _, r in df.iterrows():
        items.append({
            "k": r["key"], "brand": r["brand"], "category": r["category"],
            "drink": r["drink"], "spec": r["spec"],
            "mg_min": int(r["mg_min"]), "mg_max": int(r["mg_max"]),
            "source": r["source"], "confidence": r["confidence"],
            "collected": str(r["collected"])[:10],
            **({"kcal": int(r["kcal"])} if pd.notna(r.get("kcal")) else {}),
            **({"note": r["note"]} if pd.notna(r.get("note")) and str(r["note"]).strip() else {}),
        })
    out = {"updated": datetime.date.today().isoformat(), "count": len(items), "items": items}
    if "--check" in sys.argv:
        print(f"校验通过: {len(items)} 条记录"); return
    with open("../beverages.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    # db.js: <script src> 同步加载，file:// 双击可用（网页版实际使用）
    with open("../db.js", "w", encoding="utf-8") as f:
        f.write("// 由 build_db.py 生成，请勿手改\nwindow.CAFFNAP_DB = ")
        json.dump(out, f, ensure_ascii=False)
        f.write(";\n")
    print(f"✅ 输出 ../beverages.json 与 ../db.js: {len(items)} 条记录")

if __name__ == "__main__":
    main()
