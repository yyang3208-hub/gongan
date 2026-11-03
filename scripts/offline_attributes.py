from __future__ import annotations

import argparse
from collections import Counter
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from uuid import NAMESPACE_URL, uuid5

for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
    os.environ[key] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
sys.dont_write_bytecode = True

COLLECTION = "offline_visible_attributes_v1"
TOKEN_BUDGET = 768
TEXT_MODEL = "intfloat/multilingual-e5-small@614241f622f53c4eeff9890bdc4f31cfecc418b3"
IMAGE_MODEL = "google/siglip-so400m-patch14-384@9fdffc58afc957d1a03a25b10dba0329ab15c2a3"
KINDS = ("person", "two_wheeler", "three_wheeler", "motor_vehicle", "other", "unknown")
BOOL = ("present", "absent", "unknown")
COLORS = ("black", "white", "gray", "red", "blue", "yellow", "orange", "brown", "green", "purple", "pink", "multi", "unknown")
H_FIELDS = (
    ("age_appearance", "外观年龄（粗略估计）", ("youth", "adult", "older", "unknown")),
    ("umbrella", "打伞", BOOL),
    ("hair", "发型", ("long", "short", "bald", "unknown")),
    ("headwear", "帽子", ("none", "hat", "helmet", "unknown")),
    ("headwear_color", "帽子颜色", COLORS + ("na",)),
    ("bag", "背包", ("none", "shoulder", "backpack", "crossbody", "unknown")),
    ("carrying", "拎东西", BOOL),
    ("mask", "口罩", BOOL),
    ("glasses", "眼镜", BOOL),
    ("suitcase", "拉杆箱", BOOL),
    ("pushcart", "手推车", BOOL),
    ("holding_child", "抱小孩", BOOL),
    ("top_pattern", "上衣纹理", ("plaid", "graphic", "colorblock", "floral", "solid", "striped", "unknown")),
    ("top_style", "上衣款式", ("long_sleeve", "short_sleeve", "sleeveless", "coat", "raincoat", "unknown")),
    ("top_color", "上衣颜色", COLORS),
    ("bottom_style", "下装款式", ("long_pants", "shorts", "cropped_pants", "skirt", "unknown")),
    ("bottom_color", "下装颜色", COLORS),
    ("shoes_color", "鞋子颜色", COLORS),
    ("orientation", "人体朝向", ("front", "back", "side", "unknown")),
)
V_FIELDS = (
    ("vehicle_type", "车辆种类", ("bicycle", "motorcycle", "open_tricycle", "canopy_tricycle", "box_tricycle", "sedan", "suv", "mpv", "van", "pickup", "small_truck", "large_truck", "minibus", "bus", "tractor", "special", "unknown")),
    ("vehicle_orientation", "车辆朝向", ("front", "back", "side", "unknown")),
    ("vehicle_color", "车辆颜色", COLORS + ("gold", "silver")),
    ("canopy", "车辆雨篷", BOOL),
    ("passenger", "车辆载人", BOOL),
    ("delivery_box", "外卖箱", BOOL),
    ("brand_model_candidate", "品牌型号候选", None),
    ("license_plate_candidate", "号牌候选（未OCR核验）", None),
    ("plate_color", "车牌颜色", ("yellow", "blue", "black", "white", "gradient_green", "unknown")),
    ("usage", "车辆用途", ("school", "container", "tanker", "mixer", "taxi", "fire", "repair", "dump", "public_bus", "coach", "learner", "ambulance", "none", "unknown")),
    ("roof_rack", "行李架", BOOL),
    ("spare_tire", "备胎", BOOL),
    ("sunroof", "天窗", BOOL),
    ("driver_sunvisor", "主驾遮阳板", BOOL),
    ("passenger_sunvisor", "副驾遮阳板", BOOL),
    ("driver_seatbelt", "主驾安全带", BOOL),
    ("passenger_seatbelt", "副驾安全带", BOOL),
    ("driver_phone_near_head", "主驾电话靠近头部（非通话确认）", BOOL),
    ("ornament", "车内摆件", BOOL),
    ("tissue_box", "纸巾盒", BOOL),
)
LABELS = {
    "person": "人体", "two_wheeler": "二轮车", "three_wheeler": "三轮车", "motor_vehicle": "机动车",
    "other": "其他物体", "unknown": "未知", "present": "有", "absent": "无", "none": "没有",
    "youth": "偏年轻外观", "adult": "中青年外观", "older": "老年外观",
    "long": "长发", "short": "短发", "bald": "光头", "hat": "帽子", "helmet": "头盔",
    "shoulder": "单肩包", "backpack": "双肩包", "crossbody": "斜挎包",
    "black": "黑色", "white": "白色", "gray": "灰色", "red": "红色", "blue": "蓝色",
    "yellow": "黄色", "orange": "橙色", "brown": "棕色", "green": "绿色", "purple": "紫色",
    "pink": "粉色", "multi": "多色", "gold": "金色", "silver": "银色", "gradient_green": "渐变绿色",
    "plaid": "格子", "graphic": "图案", "colorblock": "拼色", "floral": "花纹", "solid": "纯色", "striped": "条纹",
    "long_sleeve": "长袖", "short_sleeve": "短袖", "sleeveless": "无袖", "coat": "外套", "raincoat": "雨衣",
    "long_pants": "长裤", "shorts": "短裤", "cropped_pants": "七分裤", "skirt": "裙子",
    "front": "正面", "back": "背面", "side": "侧面", "bicycle": "自行车", "motorcycle": "摩托车",
    "open_tricycle": "斗式三轮车", "canopy_tricycle": "蓬式三轮车", "box_tricycle": "厢式三轮车",
    "sedan": "轿车", "suv": "越野车", "mpv": "商务车", "van": "面包车", "pickup": "皮卡车",
    "small_truck": "小型货车", "large_truck": "大型货车", "minibus": "小型客车", "bus": "大型客车",
    "tractor": "拖拉机", "special": "特种车辆", "school": "校车", "container": "集装箱车",
    "tanker": "油罐车", "mixer": "搅拌车", "taxi": "出租车", "fire": "消防车", "repair": "工程抢修车",
    "dump": "渣土车", "public_bus": "公交车", "coach": "长途客车", "learner": "教练车", "ambulance": "救护车",
}
UNSUPPORTED = ("gender", "identity_matching", "cross_video_grouping", "person_alerts", "verified_plate_ocr", "phone_call_confirmation")
SCHEMA_ID = hashlib.sha256(repr((H_FIELDS, V_FIELDS, UNSUPPORTED, "scoped-named-fields-v3")).encode()).hexdigest()


def save_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".pending")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def normalize_packet(packet: dict) -> dict:
    if not isinstance(packet, dict) or not {"k", "h", "v"} <= set(packet) or set(packet) - {"k", "h", "v", "o", "q"}:
        raise ValueError("Unexpected attribute schema.")
    kind = packet["k"]
    quality = packet.get("q", "unassessed")
    if kind not in KINDS or quality not in ("clear", "partial", "tiny", "unclear", "unassessed"):
        raise ValueError("Invalid entity type or quality.")
    noun = packet.get("o", kind)
    if not isinstance(noun, str) or not re.fullmatch(r"[a-z][a-z _-]{0,39}", noun):
        raise ValueError("Object noun must be short and non-identifying.")
    if re.search(r"\b(male|female|man|woman|boy|girl)\b", noun):
        raise ValueError("Gender inference is outside the approved scope.")
    human, vehicle = packet["h"], packet["v"]
    for key, fields in (("h", H_FIELDS), ("v", V_FIELDS)):
        if isinstance(packet[key], dict):
            names = [name for name, _, _ in fields]
            if packet[key] and set(packet[key]) != set(names):
                raise ValueError("Incomplete named attributes.")
            values = [packet[key][name] for name in names] if packet[key] else []
            if key == "h":
                human = values
            else:
                vehicle = values
    if not isinstance(human, list) or not isinstance(vehicle, list):
        raise ValueError("Attributes must be ordered arrays.")
    is_vehicle = kind in ("two_wheeler", "three_wheeler", "motor_vehicle")
    if kind == "person" and len(human) != len(H_FIELDS):
        raise ValueError("Incomplete human attributes.")
    if is_vehicle and len(vehicle) != len(V_FIELDS):
        raise ValueError("Incomplete vehicle attributes.")
    if not is_vehicle and vehicle:
        raise ValueError("Non-vehicle cannot have vehicle attributes.")
    if kind not in ("person", "two_wheeler", "three_wheeler") and human:
        raise ValueError("No main person or visible rider is established.")
    if human and len(human) != len(H_FIELDS):
        raise ValueError("Incomplete visible-rider attributes.")
    attributes = {}
    for fields, values in ((H_FIELDS, human), (V_FIELDS, vehicle)):
        for (name, _, allowed), value in zip(fields, values):
            if isinstance(value, str) and value.startswith(name + "="):
                value = value[len(name) + 1:]
            if not isinstance(value, str) or (allowed is not None and value not in allowed):
                raise ValueError(f"Invalid value for {name}.")
            if allowed is None and (not value.strip() or len(value) > 50):
                raise ValueError(f"Invalid candidate text for {name}.")
            if value == "unknown":
                attributes[name] = {"value": None, "status": "unknown"}
            elif value == "na":
                attributes[name] = {"value": None, "status": "not_applicable"}
            elif name == "age_appearance":
                attributes[name] = {"value": value, "status": "estimated", "requiresHumanReview": True}
            elif name.endswith("_candidate"):
                attributes[name] = {"value": value, "status": "unverified", "requiresHumanReview": True}
            else:
                attributes[name] = {"value": value, "status": "model_observation"}
    if attributes.get("headwear", {}).get("value") == "none":
        attributes["headwear_color"] = {"value": None, "status": "not_applicable", "reason": "no_headwear"}
    if attributes.get("orientation", {}).get("value") == "back":
        for name in ("age_appearance", "mask", "glasses"):
            attributes[name] = {"value": None, "status": "unknown", "reason": "face_not_established_in_back_view"}
    return {
        "kind": kind, "objectNoun": noun, "quality": quality, "attributes": attributes,
        "objectNounOrigin": "model" if "o" in packet else "category_derived",
        "qualityOrigin": "model" if "q" in packet else "not_assessed",
        "humanAttributeSubject": "main_person" if kind == "person" else "visible_rider" if human else None,
        "requiresHumanReview": True, "unsupported": list(UNSUPPORTED),
    }


def attribute_text(record: dict) -> str:
    parts = ["图片可见主体：" + LABELS[record["kind"]], "物体：" + record["objectNoun"]]
    for name, label, _ in (*H_FIELDS, *V_FIELDS):
        item = record["attributes"].get(name)
        if item is None or item["status"] in ("unknown", "not_applicable", "unverified"):
            continue
        parts.append(label + "：" + LABELS[item["value"]])
    return "；".join(parts)


def prompt(kind: str | None = None) -> str:
    human = "\n".join(f"{name}: {','.join(values)}" for name, _, values in H_FIELDS)
    vehicle = "\n".join(f"{name}: {','.join(values) if values else 'unknown or directly legible text; never guess'}" for name, _, values in V_FIELDS)
    return (
        "Inspect the MAIN object centered in this crop, not neighbors or background. "
        "Never infer gender, identity, ethnicity, health or other sensitive traits. "
        "Age_appearance is only a rough visual estimate; use unknown without a sufficient visible person. "
        "Use unknown for cropped, occluded, tiny or unreadable features. Absence requires a clearly visible relevant area. "
        "Do not guess a brand or plate. A phone near the head does not establish a phone call. "
        "Use one predominant clothing color, or multi. Do not confuse clothes with bags or neighbors. "
        "Return ONLY compact JSON with exactly keys k,h,v. "
        "k is person,two_wheeler,three_wheeler,motor_vehicle,other,unknown. "
        "h and v are objects with the named fields below. "
        "h has all 19 fields for a main person; for two/three wheelers include h only if a rider is visible, otherwise {}. "
        "v has all 20 fields only for vehicles, otherwise {}. For other/unknown, both objects must be {}. "
        "Keep every required entry. Recognize clearly visible features; use unknown ONLY for unobservable features."
        + ("\nH fields:\n" + human if kind in (None, "person", "two_wheeler", "three_wheeler") else "")
        + ("\nV fields:\n" + vehicle if kind in (None, "two_wheeler", "three_wheeler", "motor_vehicle") else "")
        + "\nOutput only k,h,v, including all required named fields."
    )


def output_schema(kind: str | None = None) -> dict:
    def fields_schema(fields):
        return {
            "type": "object", "additionalProperties": False,
            "properties": {name: {"enum": list(values)} if values else {"type": "string", "minLength": 1, "maxLength": 50} for name, _, values in fields},
            "required": [name for name, _, _ in fields],
        }
    empty = {"type": "object", "properties": {}, "additionalProperties": False}
    human, vehicle = fields_schema(H_FIELDS), fields_schema(V_FIELDS)
    branches = []
    for kinds, h, v in (
        (["person"], human, empty),
        (["two_wheeler", "three_wheeler"], {"anyOf": [human, empty]}, vehicle),
        (["motor_vehicle"], empty, vehicle),
        (["other", "unknown"], empty, empty),
    ):
        branches.append({
            "type": "object", "additionalProperties": False, "required": ["k", "h", "v"],
            "properties": {"k": {"enum": kinds}, "h": h, "v": v},
        })
    if kind is not None:
        if kind not in KINDS:
            raise ValueError("Unsupported output category.")
        return next(branch for branch in branches if kind in branch["properties"]["k"]["enum"]) | {
            "properties": next(branch for branch in branches if kind in branch["properties"]["k"]["enum"])["properties"] | {"k": {"enum": [kind]}}
        }
    return {"anyOf": branches}


class AttributeWorker:
    def __init__(self, worker) -> None:
        from lmformatenforcer.tokenenforcer import TokenEnforcerTokenizerData

        self.worker = worker
        tokenizer = worker.tokenizer
        zero = tokenizer.encode("0")[-1]
        special = set(tokenizer.all_special_ids)
        regular = []
        for index in range(len(tokenizer)):
            if index not in special:
                after_zero = tokenizer.decode([zero, index])[1:]
                alone = tokenizer.decode([index])
                regular.append((index, after_zero, len(after_zero) > len(alone)))
        self.tokenizer_data = TokenEnforcerTokenizerData(
            regular, lambda ids: tokenizer.decode(ids).rstrip("\ufffd"),
            tokenizer.eos_token_id, False, len(tokenizer),
        )

    def predict(self, image, question: str, max_new_tokens: int, temperature: float, schema: dict | None = None) -> dict:
        import torch
        from lmformatenforcer import JsonSchemaParser
        from lmformatenforcer.tokenenforcer import TokenEnforcer
        from vlx_seek_worker import KeywordsStoppingCriteria, tokenizer_image_token

        if temperature != 0:
            raise ValueError("Attribute extraction is deterministic.")
        worker = self.worker
        images, grids, auxiliary = worker._prepare_image_inputs(image, [])
        raw = tokenizer_image_token(worker._build_prompt(question, []), worker.tokenizer, return_tensors="pt")
        ids = worker._expand_multimodal_tokens(raw, grids).unsqueeze(0).to(worker.device)
        enforcer = TokenEnforcer(self.tokenizer_data, JsonSchemaParser(schema or output_schema()))
        output = worker.model.generate(
            inputs=ids, attention_mask=torch.ones_like(ids), images=images,
            images_aux=auxiliary, image_grid_thws=grids, bbox_list=None,
            max_new_tokens=max_new_tokens, do_sample=False, use_cache=True,
            pad_token_id=worker.tokenizer.pad_token_id,
            stopping_criteria=[KeywordsStoppingCriteria(["<|im_end|>"], worker.tokenizer, ids)],
            prefix_allowed_tokens_fn=lambda batch, sequence: enforcer.get_allowed_tokens(sequence.tolist()).allowed_tokens,
        )
        completion = output[0, ids.shape[1]:]
        return {
            "answer": worker.tokenizer.decode(completion, skip_special_tokens=False).replace("<|im_end|>", "").strip(),
            "completion_tokens": len(completion),
        }


def checked_packet(answer: dict) -> dict:
    if answer["completion_tokens"] >= TOKEN_BUDGET:
        raise ValueError("VLX attribute output truncated.")
    text = answer["answer"].strip()
    if text.startswith("```json\n") and text.endswith("```"):
        text = text[8:-3].strip()
    packet = json.loads(text)
    normalize_packet(packet)
    return packet


def initialize(args) -> dict:
    source = args.source.resolve()
    result = json.loads((source / "result.json").read_text(encoding="utf-8"))
    if result["status"] != "completed" or result["embeddingModel"] != IMAGE_MODEL:
        raise ValueError("A completed, pinned source extraction is required.")
    matrix_path = source / "crop-vectors.npy"
    import numpy as np
    matrix = np.load(matrix_path, allow_pickle=False)
    if matrix.shape != (len(result["vectorItems"]), 1152) or not np.isfinite(matrix).all() or not np.allclose(np.linalg.norm(matrix, axis=1), 1, atol=1e-4):
        raise ValueError("Invalid source image vectors.")
    args.output.mkdir(parents=True, exist_ok=True)
    manifest_path = args.output / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest["sourceSha256"] != result["sourceSha256"] or manifest["schemaId"] != SCHEMA_ID:
            raise ValueError("Existing test dataset differs; choose a new output directory.")
        if len(manifest["images"]) != len(result["vectorItems"]):
            raise ValueError("Source image count changed.")
        return manifest
    (args.output / "images").mkdir(exist_ok=False)
    (args.output / "failures").mkdir(exist_ok=False)
    tracks = {item["id"]: item["label"] for item in result["tracks"]}
    images = []
    for item in result["vectorItems"]:
        original = (source / item["crop"]).resolve()
        if not original.is_relative_to(source) or not original.is_file():
            raise ValueError("Invalid source crop path.")
        identity = str(uuid5(NAMESPACE_URL, result["sourceSha256"] + ":" + item["crop"]))
        filename = "images/" + identity + ".jpg"
        shutil.copy2(original, args.output / filename)
        images.append({
            "id": identity, "vectorRow": item["vectorRow"], "image": filename,
            "imageSha256": hashlib.sha256(original.read_bytes()).hexdigest(),
            "sourceCandidateLabel": tracks[item["trackId"]],
            "timestampSeconds": item["timestampSeconds"], "sourceFrameIndex": item["sourceFrameIndex"],
            "boxXYXY": item["boxXYXY"],
        })
    shutil.copy2(matrix_path, args.output / "appearance-vectors.npy")
    manifest = {
        "sourceSha256": result["sourceSha256"], "schemaId": SCHEMA_ID,
        "sourceVideo": result["source"], "sourceFrameCount": result["decodedFrames"],
        "imageModel": IMAGE_MODEL, "textModel": TEXT_MODEL, "images": images,
        "scope": "Image-level visible attributes only; no identity matching, grouping or alerts",
        "unsupported": list(UNSUPPORTED),
    }
    save_json(manifest_path, manifest)
    return manifest


def extract_one(worker, item: dict, output: Path) -> dict:
    from PIL import Image
    import torch

    path = output / item["image"]
    if hashlib.sha256(path.read_bytes()).hexdigest() != item["imageSha256"]:
        raise ValueError("Image checksum changed.")
    with Image.open(path) as source:
        image = source.convert("RGB")
    started = time.monotonic()
    class_schema = {
        "type": "object", "required": ["kind"], "additionalProperties": False,
        "properties": {"kind": {"enum": list(KINDS)}},
    }
    with torch.inference_mode():
        classification = worker.predict(
            image, "Classify ONLY the primary object centered in this crop. Do not follow an example. "
            "person means a visible person or torso. two_wheeler means a bicycle or motorcycle, "
            "three_wheeler means a tricycle, motor_vehicle means a car/bus/truck/train. "
            "other means bowls, bags, umbrellas, animals or other objects. "
            "unknown means the main object cannot be judged. "
            "Return JSON with only kind and no other fields.",
            max_new_tokens=64, temperature=0, schema=class_schema,
        )
    if classification["completion_tokens"] >= 64:
        raise ValueError("Category output truncated.")
    category_packet = json.loads(classification["answer"])
    if set(category_packet) != {"kind"} or category_packet["kind"] not in KINDS:
        raise ValueError("Invalid category output.")
    kind = category_packet["kind"]
    request = prompt(kind) + "\nThe separately classified primary entity type is " + kind + ". Use this exact k."
    for attempt in range(2):
        with torch.inference_mode():
            answer = worker.predict(image, request, max_new_tokens=TOKEN_BUDGET, temperature=0, schema=output_schema(kind))
        try:
            packet = checked_packet(answer)
            normalized = normalize_packet(packet)
            break
        except (ValueError, json.JSONDecodeError) as error:
            diagnostic = {
                "imageId": item["id"], "attempt": attempt + 1, "error": str(error),
                "rawAnswer": re.sub(r"\b(male|female|man|woman|boy|girl)\b", "[unsupported]", answer["answer"], flags=re.I),
                "completionTokens": answer["completion_tokens"],
            }
            save_json(output / "failures" / f"{item['id']}-{attempt}.json", diagnostic)
            if attempt == 1:
                raise ValueError(f"Attribute validation failed for image {item['id']}: {error}") from error
            print(f"Retrying invalid attribute output for image {item['vectorRow']}: {error}", flush=True)
            request = prompt(kind) + "\nYour previous response failed validation: " + str(error) + ". Correct the schema; do not add explanations."
    record = {
        **item, **normalized, "packet": packet, "rawAnswer": answer["answer"],
        "completionTokens": answer["completion_tokens"], "inferenceSeconds": time.monotonic() - started,
        "smallTarget": image.width < 48 or image.height < 80,
        "vlxModel": "VLX-Seek-1.5-10B, NF4 language layers",
        "classificationAnswer": classification["answer"],
    }
    record["attributeText"] = attribute_text(record)
    candidate_kind = {
        "person": "person", "bicycle": "two_wheeler", "motorcycle": "two_wheeler",
        "car": "motor_vehicle", "truck": "motor_vehicle", "bus": "motor_vehicle", "train": "motor_vehicle",
    }.get(item["sourceCandidateLabel"], "other")
    record["categoryConflict"] = candidate_kind != record["kind"]
    return record


def extract(args, probe_only: bool) -> None:
    manifest = initialize(args)
    sys.path.insert(0, str(args.root / "ai"))
    from vlx_runtime import load_worker

    images = manifest["images"]
    if probe_only:
        chosen = []
        for label in ("person", "car", "motorcycle", "truck", "umbrella", "handbag", "bowl"):
            candidates = [item for item in images if item["sourceCandidateLabel"] == label]
            candidates.sort(key=lambda item: (item["boxXYXY"][2] - item["boxXYXY"][0]) * (item["boxXYXY"][3] - item["boxXYXY"][1]), reverse=True)
            chosen.extend(candidates[:3] if label == "person" else candidates[:1])
        chosen += [min((item for item in images if item["sourceCandidateLabel"] == "person"), key=lambda item: (item["boxXYXY"][2]-item["boxXYXY"][0])*(item["boxXYXY"][3]-item["boxXYXY"][1]))]
        worker = AttributeWorker(load_worker())
        records = [extract_one(worker, item, args.output) for item in chosen]
        save_json(args.output / "probe.json", {"schemaId": SCHEMA_ID, "records": records})
        print(json.dumps({
            "probeImages": len(records), "kinds": dict(Counter(item["kind"] for item in records)),
            "seconds": sum(item["inferenceSeconds"] for item in records),
            "rows": [item["vectorRow"] for item in records],
        }), flush=True)
        return
    path = args.output / "attributes.jsonl"
    records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []
    completed = {item["id"] for item in records}
    if len(completed) != len(records) or not completed <= {item["id"] for item in images}:
        raise ValueError("Duplicate or unrelated completed image records.")
    for record in records:
        normalize_packet(record["packet"])
    probe_path = args.output / "probe.json"
    if probe_path.exists():
        probe = json.loads(probe_path.read_text(encoding="utf-8"))
        if probe["schemaId"] != SCHEMA_ID:
            raise ValueError("Probe schema differs.")
        with path.open("a", encoding="utf-8") as stream:
            for record in probe["records"]:
                record.update(normalize_packet(record["packet"]))
                record["attributeText"] = attribute_text(record)
                candidate_kind = {
                    "person": "person", "bicycle": "two_wheeler", "motorcycle": "two_wheeler",
                    "car": "motor_vehicle", "truck": "motor_vehicle", "bus": "motor_vehicle", "train": "motor_vehicle",
                }.get(record["sourceCandidateLabel"], "other")
                record["categoryConflict"] = candidate_kind != record["kind"]
                if record["id"] not in completed:
                    stream.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")
                    records.append(record)
                    completed.add(record["id"])
            stream.flush()
            os.fsync(stream.fileno())
    state = {"status": "extracting", "planned": len(images), "processed": len(completed), "schemaId": SCHEMA_ID}
    save_json(args.output / "state.json", state)
    started = time.monotonic()
    try:
        worker = AttributeWorker(load_worker())
        with path.open("a", encoding="utf-8") as stream:
            for item in images:
                if item["id"] in completed:
                    continue
                record = extract_one(worker, item, args.output)
                stream.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
                records.append(record)
                completed.add(item["id"])
                if len(completed) % 25 == 0:
                    state["processed"] = len(completed)
                    save_json(args.output / "state.json", state)
                    print(f"Structured {len(completed)}/{len(images)} images", flush=True)
        if len(records) != len(images):
            raise ValueError("Incomplete image coverage.")
        state.update({
            "status": "extracted", "processed": len(records), "extractStageSeconds": time.monotonic() - started,
            "kindCounts": dict(Counter(item["kind"] for item in records)),
            "fieldUnknownCounts": dict(Counter(name for item in records for name, value in item["attributes"].items() if value["status"] == "unknown")),
        })
        save_json(args.output / "state.json", state)
    except Exception as error:
        state.update({"status": "failed", "processed": len(completed), "error": str(error)})
        save_json(args.output / "state.json", state)
        raise


@contextmanager
def text_encoder(root: Path, output: Path):
    with (output / "embedding-worker.log").open("a", encoding="utf-8") as log:
        process = subprocess.Popen(
            [sys.executable, "-u", str(root / "ai" / "text_embedding_worker.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
        )
        try:
            def encode(kind: str, text: str) -> list[float]:
                process.stdin.write((json.dumps({"kind": kind, "text": text}, ensure_ascii=False) + "\n").encode("utf-8"))
                process.stdin.flush()
                line = process.stdout.readline()
                if not line:
                    raise RuntimeError("Embedding worker stopped; inspect embedding-worker.log.")
                response = json.loads(line)
                if "error" in response:
                    raise RuntimeError(response["error"])
                if response.get("model") != TEXT_MODEL or "vector" not in response:
                    raise ValueError("Embedding worker failed or model changed.")
                vector = response["vector"]
                if len(vector) != 384 or not all(math.isfinite(value) for value in vector) or abs(sum(value * value for value in vector) - 1) > 1e-4:
                    raise ValueError("Invalid real text embedding.")
                return vector
            yield encode
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise RuntimeError("Embedding worker did not shut down within 30 seconds.")
            process.stdout.close()
            if process.returncode != 0 and sys.exc_info()[0] is None:
                raise RuntimeError("Embedding worker exited unsuccessfully; inspect its log.")


def create_collection(client) -> None:
    from qdrant_client import models

    if not client.collection_exists(COLLECTION):
        client.create_collection(COLLECTION, vectors_config={
            "attributes": models.VectorParams(size=384, distance=models.Distance.COSINE),
            "appearance": models.VectorParams(size=1152, distance=models.Distance.COSINE),
        })
    vectors = client.get_collection(COLLECTION).config.params.vectors
    if not isinstance(vectors, dict) or set(vectors) != {"attributes", "appearance"}:
        raise ValueError("Named-vector schema mismatch.")
    if any(vectors[name].size != size or vectors[name].distance != models.Distance.COSINE for name, size in (("attributes", 384), ("appearance", 1152))):
        raise ValueError("Vector dimensions or metrics changed.")


def query_filter(kind: str | None, fields: list[str]):
    from qdrant_client import models

    conditions = []
    if kind is not None:
        if kind not in KINDS:
            raise ValueError("Unknown query category.")
        conditions.append(models.FieldCondition(key="kind", match=models.MatchValue(value=kind)))
    specs = {name: allowed for name, _, allowed in (*H_FIELDS, *V_FIELDS)}
    for expression in fields:
        name, separator, value = expression.partition("=")
        if not separator or name not in specs or specs[name] is None or name == "age_appearance" or value not in specs[name] or value in ("unknown", "na"):
            raise ValueError("Unsupported field or value; age estimates are not exact filters.")
        conditions.append(models.FieldCondition(key=f"attributes.{name}.value", match=models.MatchValue(value=value)))
    return models.Filter(must=conditions) if conditions else None


def index(args) -> None:
    import numpy as np
    from qdrant_client import QdrantClient, models

    manifest = json.loads((args.output / "manifest.json").read_text(encoding="utf-8"))
    state = json.loads((args.output / "state.json").read_text(encoding="utf-8"))
    if state["status"] not in ("extracted", "indexed") or manifest["schemaId"] != SCHEMA_ID:
        raise ValueError("Indexing requires completed, matching attributes.")
    records = [json.loads(line) for line in (args.output / "attributes.jsonl").read_text(encoding="utf-8").splitlines()]
    if len(records) != len(manifest["images"]) or len({item["id"] for item in records}) != len(records):
        raise ValueError("Incomplete or duplicated attribute records.")
    matrix = np.load(args.output / "appearance-vectors.npy", allow_pickle=False)
    if matrix.shape != (len(records), 1152) or not np.isfinite(matrix).all() or not np.allclose(np.linalg.norm(matrix, axis=1), 1, atol=1e-4):
        raise ValueError("Invalid saved appearance vectors.")
    if {item["id"] for item in records} != {item["id"] for item in manifest["images"]} or {item["vectorRow"] for item in records} != set(range(len(records))):
        raise ValueError("Attribute IDs or vector rows differ from the input dataset.")
    database = args.output / "qdrant"
    client = QdrantClient(path=str(database))
    started = time.monotonic()
    try:
        create_collection(client)
        points, vectors = [], []
        with text_encoder(args.root, args.output) as encode:
            for item in records:
                normalized = normalize_packet(item["packet"])
                if normalized["attributes"] != item["attributes"] or attribute_text(normalized) != item["attributeText"]:
                    raise ValueError("Cached attributes differ from the validated model response.")
                if hashlib.sha256((args.output / item["image"]).read_bytes()).hexdigest() != item["imageSha256"]:
                    raise ValueError("Persistent image checksum changed.")
                vector = encode("passage", item["attributeText"])
                vectors.append(vector)
                appearance = matrix[item["vectorRow"]].tolist()
                points.append(models.PointStruct(id=item["id"], vector={"attributes": vector, "appearance": appearance}, payload={
                    key: item[key] for key in ("image", "vectorRow", "timestampSeconds", "sourceFrameIndex", "boxXYXY", "kind", "objectNoun", "quality", "smallTarget", "categoryConflict", "attributes", "attributeText", "requiresHumanReview", "humanAttributeSubject")
                }))
                if len(points) == 50:
                    client.upsert(COLLECTION, points=points, wait=True)
                    points.clear()
            if points:
                client.upsert(COLLECTION, points=points, wait=True)
        count = client.count(COLLECTION, exact=True).count
        if count != len(records):
            raise ValueError("Persistent database count mismatch.")
        np.save(args.output / "attribute-vectors.npy", np.array(vectors, dtype=np.float32))
        save_json(args.output / "vector-order.json", {"imageIds": [item["id"] for item in records]})
        state.update({"status": "indexed", "databaseCount": count, "collection": COLLECTION, "indexSeconds": time.monotonic() - started})
        save_json(args.output / "state.json", state)
        print(json.dumps({"indexed": count, "collection": COLLECTION, "database": str(database), "seconds": state["indexSeconds"]}), flush=True)
    finally:
        client.close()


def query(args) -> dict:
    from qdrant_client import QdrantClient

    state = json.loads((args.output / "state.json").read_text(encoding="utf-8"))
    if state["status"] != "indexed":
        raise ValueError("A fully indexed dataset is required.")
    if not 1 <= args.limit <= 200 or args.offset < 0:
        raise ValueError("Invalid limit or offset.")
    filters = query_filter(args.kind, args.field)
    client = QdrantClient(path=str(args.output / "qdrant"))
    started = time.monotonic()
    try:
        create_collection(client)
        if args.text is not None:
            if not args.text.strip() or len(args.text) > 512 or re.search(r"性别|男性|女性|男人|女人|真实身份|人脸识别|跨视频|聚档|布控", args.text):
                raise ValueError("Query is empty, too long or outside the approved visible-image scope.")
            with text_encoder(args.root, args.output) as encode:
                vector = encode("query", args.text)
            using = "attributes"
        else:
            item = client.retrieve(COLLECTION, ids=[args.image_id], with_vectors=["appearance"])
            if len(item) != 1:
                raise ValueError("Unknown image ID.")
            vector = item[0].vector["appearance"]
            using = "appearance"
        tick = time.monotonic()
        response = client.query_points(COLLECTION, query=vector, using=using, query_filter=filters, limit=args.limit, offset=args.offset, with_payload=True)
        matches = []
        for point in response.points:
            payload = point.payload
            image = (args.output / payload["image"]).resolve()
            if not image.is_relative_to(args.output.resolve()) or not image.is_file():
                raise ValueError("Database image reference is missing or invalid.")
            matches.append({"imageId": str(point.id), "score": point.score, "imagePath": str(image), **payload})
        result = {
            "query": args.text, "imageQueryId": args.image_id, "using": using, "kind": args.kind,
            "exactFields": args.field, "limit": args.limit, "offset": args.offset,
            "filteredImageCount": client.count(COLLECTION, count_filter=filters, exact=True).count,
            "databaseSearchMilliseconds": (time.monotonic() - tick) * 1000,
            "totalSeconds": time.monotonic() - started,
            "notice": "Similarity-ranked image candidates, not identity matches or calibrated probabilities. Attributes and apparent age require human review.",
            "items": matches,
        }
        print(json.dumps(result, ensure_ascii=True, allow_nan=False, indent=2), flush=True)
        if args.result:
            save_json(args.result, result)
        return result
    finally:
        client.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / ".local" / "offline-attributes-test-v3")
    sub = parser.add_subparsers(dest="operation", required=True)
    for name in ("probe", "extract"):
        command = sub.add_parser(name)
        command.add_argument("--source", required=True, type=Path)
    sub.add_parser("index")
    command = sub.add_parser("query")
    mode = command.add_mutually_exclusive_group(required=True)
    mode.add_argument("--text")
    mode.add_argument("--image-id")
    command.add_argument("--kind", choices=KINDS)
    command.add_argument("--field", action="append", default=[])
    command.add_argument("--limit", type=int, default=10)
    command.add_argument("--offset", type=int, default=0)
    command.add_argument("--result", type=Path)
    args = parser.parse_args()
    if args.operation in ("probe", "extract"):
        extract(args, args.operation == "probe")
    elif args.operation == "index":
        index(args)
    else:
        query(args)


if __name__ == "__main__":
    main()
