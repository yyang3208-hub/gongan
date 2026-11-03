import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from offline_attributes import COLLECTION, H_FIELDS, create_collection, normalize_packet, query_filter


def person_packet():
    return {"k": "person", "h": ["unknown"] * len(H_FIELDS), "v": [], "o": "person", "q": "partial"}


class AttributeTests(unittest.TestCase):
    def test_unknown_is_not_absent(self):
        value = normalize_packet(person_packet())
        self.assertEqual(value["attributes"]["mask"], {"value": None, "status": "unknown"})
        self.assertNotIn("gender", value["attributes"])

    def test_age_is_only_an_estimate(self):
        packet = person_packet()
        packet["h"][0] = "older"
        value = normalize_packet(packet)["attributes"]["age_appearance"]
        self.assertEqual(value["status"], "estimated")
        self.assertTrue(value["requiresHumanReview"])

    def test_nonhuman_does_not_invent_human_attributes(self):
        value = normalize_packet({"k": "other", "h": [], "v": [], "o": "bowl", "q": "clear"})
        self.assertEqual(value["attributes"], {})

    def test_invalid_schema_and_gender_inference_are_rejected(self):
        packet = person_packet()
        packet["h"][2] = "imagined"
        with self.assertRaises(ValueError):
            normalize_packet(packet)
        packet = person_packet()
        packet["o"] = "woman"
        with self.assertRaises(ValueError):
            normalize_packet(packet)
        packet = person_packet()
        packet["gender"] = "female"
        with self.assertRaises(ValueError):
            normalize_packet(packet)

    def test_filters_reject_unknown_or_identity_fields(self):
        with self.assertRaises(ValueError):
            query_filter("person", ["gender=male"])
        with self.assertRaises(ValueError):
            query_filter("person", ["top_color=imagined"])

    def test_named_array_entries_match_their_exact_fields(self):
        packet = {"k": "person", "h": [name + "=unknown" for name, _, _ in H_FIELDS], "v": []}
        packet["h"][14] = "top_color=yellow"
        result = normalize_packet(packet)
        self.assertEqual(result["attributes"]["top_color"]["value"], "yellow")
        self.assertEqual(result["qualityOrigin"], "not_assessed")
        packet["h"][14] = "shoes_color=yellow"
        with self.assertRaises(ValueError):
            normalize_packet(packet)

    def test_schema_constrains_named_fields(self):
        from lmformatenforcer import JsonSchemaParser
        from offline_attributes import output_schema

        packet = {"k": "person", "h": {name: "unknown" for name, _, _ in H_FIELDS}, "v": {}}
        parser = JsonSchemaParser(output_schema())
        for character in json.dumps(packet):
            self.assertIn(character, parser.get_allowed_characters())
            parser = parser.add_character(character)
        self.assertTrue(parser.can_end())
        self.assertEqual(normalize_packet(packet)["attributes"]["top_color"]["status"], "unknown")
        del packet["h"]["top_color"]
        with self.assertRaises(ValueError):
            normalize_packet(packet)

    def test_back_view_and_missing_headwear_do_not_invent_face_attributes(self):
        packet = person_packet()
        packet["h"][0] = "adult"
        packet["h"][3] = "none"
        packet["h"][4] = "black"
        packet["h"][7] = "absent"
        packet["h"][8] = "absent"
        packet["h"][18] = "back"
        attributes = normalize_packet(packet)["attributes"]
        self.assertEqual(attributes["headwear_color"]["status"], "not_applicable")
        for name in ("age_appearance", "mask", "glasses"):
            self.assertEqual(attributes[name]["status"], "unknown")

    def test_named_vectors_filters_and_database_reopening(self):
        from qdrant_client import QdrantClient, models

        with tempfile.TemporaryDirectory() as folder:
            client = QdrantClient(path=folder)
            create_collection(client)
            unit_text = [1.0] + [0.0] * 383
            unit_image = [1.0] + [0.0] * 1151
            client.upsert(COLLECTION, points=[
                models.PointStruct(
                    id=1, vector={"attributes": unit_text, "appearance": unit_image},
                    payload={"kind": "person", "attributes": {"top_color": {"value": "yellow"}}},
                ),
                models.PointStruct(
                    id=2, vector={"attributes": unit_text, "appearance": unit_image},
                    payload={"kind": "person", "attributes": {"top_color": {"value": None}}},
                ),
            ], wait=True)
            client.close()
            client = QdrantClient(path=folder)
            try:
                result = client.query_points(
                    COLLECTION, query=unit_text, using="attributes",
                    query_filter=query_filter("person", ["top_color=yellow"]),
                )
                self.assertEqual([point.id for point in result.points], [1])
                self.assertEqual(client.count(COLLECTION, exact=True).count, 2)
            finally:
                client.close()


if __name__ == "__main__":
    unittest.main()
