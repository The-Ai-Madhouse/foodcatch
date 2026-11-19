-- FoodCatch web: development seed data.
--
-- Fills the pipeline-owned public tables of a LOCAL development database with a small, realistic
-- sample (stores around Rådhuspladsen in Copenhagen, one week of Netto offers, competitor offers,
-- REMA 1000 shelf prices and campaigns, Lidl "Fast lav pris" shelf prices, earlier offers,
-- EAN shelf prices over time, food-waste clearances and pipeline runs) so every page of the web
-- app renders. Deals are written for the started offers of every chain (`api.current_deals`). All dates are relative to now(), so re-seeding keeps it current.
--
-- Run with `pnpm db:seed` (see web/README.md). Never run this against production: it TRUNCATEs
-- every data table. The schema itself comes from the pipeline's Alembic migrations.

BEGIN;

-- Copenhagen midnight `n` days from today, and the last second of that day.
CREATE FUNCTION pg_temp.day(n int) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT (date_trunc('day', now() AT TIME ZONE 'Europe/Copenhagen') + make_interval(days => n))
         AT TIME ZONE 'Europe/Copenhagen'
$$;
CREATE FUNCTION pg_temp.day_end(n int) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT pg_temp.day(n + 1) - interval '1 second'
$$;

TRUNCATE public.deal, public.review_item, public.classification, public.classification_override,
         public.listing, public.product_reference_price, public.product, public.store,
         public.raw_object, public.fetch_run;

-- ---------------------------------------------------------------------------------------------
-- Pipeline runs (latest run per job is what /status shows) and their raw objects.
-- ---------------------------------------------------------------------------------------------
INSERT INTO public.fetch_run (id, job, source, status, started_at, finished_at, git_sha, stats, error)
VALUES
  ('f0000000-0000-4000-8000-000000000001', 'tjek-offers', 'tjek', 'succeeded',
   now() - interval '3 hours 5 minutes', now() - interval '3 hours', 'a1b2c3d',
   '{"requests": 41, "listings": 1873, "classified": 412, "deals": 96}', NULL),
  ('f0000000-0000-4000-8000-000000000002', 'tjek-offers', 'tjek', 'succeeded',
   now() - interval '56 days', now() - interval '56 days' + interval '4 minutes', '9f8e7d6',
   '{"requests": 39, "listings": 1790, "classified": 398, "deals": 91}', NULL),
  ('f0000000-0000-4000-8000-000000000003', 'rema-products', 'rema', 'succeeded',
   now() - interval '5 hours 2 minutes', now() - interval '5 hours', 'a1b2c3d',
   '{"requests": 4, "listings": 3956, "classified": 701}', NULL),
  ('f0000000-0000-4000-8000-000000000004', 'salling-food-waste', 'salling', 'succeeded',
   now() - interval '1 hour', now() - interval '52 minutes', 'a1b2c3d',
   '{"requests": 212, "stores": 211, "clearances": 9412, "listings": 1630}', NULL),
  ('f0000000-0000-4000-8000-000000000005', 'off-enrich', 'openfoodfacts', 'degraded',
   now() - interval '6 hours', now() - interval '5 hours 45 minutes', 'a1b2c3d',
   '{"requests": 60, "found": 22, "not_found": 38}', NULL),
  ('f0000000-0000-4000-8000-000000000006', 'tjek-stores', 'tjek', 'succeeded',
   now() - interval '2 days', now() - interval '2 days' + interval '6 minutes', 'a1b2c3d',
   '{"requests": 58, "stores": 5612}', NULL),
  ('f0000000-0000-4000-8000-000000000007', 'salling-stores', 'salling', 'succeeded',
   now() - interval '10 days', now() - interval '10 days' + interval '2 minutes', '9f8e7d6',
   '{"requests": 9, "stores": 1764}', NULL),
  ('f0000000-0000-4000-8000-000000000008', 'salling-stores', 'salling', 'failed',
   now() - interval '3 days', now() - interval '3 days' + interval '3 minutes', 'a1b2c3d',
   '{"requests": 5}',
   'SourceError: HTTP 503 from https://api.sallinggroup.com/v2/stores (page 1) after 5 attempts');

INSERT INTO public.raw_object (id, fetch_run_id, source, endpoint, params, storage_key, sha256, bytes, fetched_at)
SELECT ('e0000000-0000-4000-8000-00000000000' || n)::uuid, r.id, r.source, endpoint, '{}'::jsonb,
       r.source || '/' || endpoint || '/seed/' || r.id || '/00001.json.gz',
       md5(r.id::text) || md5(endpoint), 1024 * n, r.started_at
FROM (VALUES (1, 'f0000000-0000-4000-8000-000000000001'::uuid, 'offers'),
             (2, 'f0000000-0000-4000-8000-000000000002'::uuid, 'offers'),
             (3, 'f0000000-0000-4000-8000-000000000003'::uuid, 'products'),
             (4, 'f0000000-0000-4000-8000-000000000004'::uuid, 'food-waste'),
             (5, 'f0000000-0000-4000-8000-000000000006'::uuid, 'stores'),
             (6, 'f0000000-0000-4000-8000-000000000007'::uuid, 'stores'))
     AS v(n, run_id, endpoint)
JOIN public.fetch_run r ON r.id = v.run_id;

-- ---------------------------------------------------------------------------------------------
-- Stores. Default location is Rådhuspladsen (55.6761, 12.5683); distances in comments.
-- MENY, Kvickly and 365discount lie between 2 and 5 km, so changing the radius changes verdicts.
-- ---------------------------------------------------------------------------------------------
INSERT INTO public.store (id, chain_id, source, source_store_id, name, street, zip, city, lat, lon)
VALUES
  ('d0000000-0000-4000-8000-000000000001', 'netto', 'salling', 'seed-netto-vesterbrogade',
   'Netto Vesterbrogade', 'Vesterbrogade 37', '1620', 'København V', 55.6730, 12.5590), -- 0,7 km
  ('d0000000-0000-4000-8000-000000000002', 'netto', 'salling', 'seed-netto-noerre-voldgade',
   'Netto Nørre Voldgade', 'Nørre Voldgade 19', '1358', 'København K', 55.6820, 12.5700), -- 0,7 km
  ('d0000000-0000-4000-8000-000000000003', 'rema1000', 'tjek', 'seed-rema-vester-voldgade',
   'REMA 1000 Vester Voldgade', 'Vester Voldgade 85', '1552', 'København V', 55.6745, 12.5700), -- 0,2 km
  ('d0000000-0000-4000-8000-000000000004', 'lidl', 'tjek', 'seed-lidl-gl-kongevej',
   'Lidl Gammel Kongevej', 'Gammel Kongevej 1', '1610', 'København V', 55.6760, 12.5480), -- 1,3 km
  ('d0000000-0000-4000-8000-000000000005', 'superbrugsen', 'tjek', 'seed-sb-christianshavn',
   'SuperBrugsen Christianshavn', 'Torvegade 47', '1400', 'København K', 55.6730, 12.5900), -- 1,4 km
  ('d0000000-0000-4000-8000-000000000006', 'foetex', 'salling', 'seed-foetex-vesterbrogade',
   'føtex Vesterbrogade', 'Vesterbrogade 50', '1620', 'København V', 55.6715, 12.5560), -- 0,9 km
  ('d0000000-0000-4000-8000-000000000007', 'meny', 'tjek', 'seed-meny-frederiksberg',
   'MENY Frederiksberg', 'Falkoner Allé 21', '2000', 'Frederiksberg', 55.6800, 12.5200), -- 3,1 km
  ('d0000000-0000-4000-8000-000000000008', 'kvickly', 'tjek', 'seed-kvickly-valby',
   'Kvickly Valby', 'Valby Langgade 89', '2500', 'Valby', 55.6640, 12.5130), -- 3,7 km
  ('d0000000-0000-4000-8000-000000000009', '365discount', 'tjek', 'seed-365-noerrebro',
   '365discount Nørrebro', 'Nørrebrogade 52', '2200', 'København N', 55.6930, 12.5520), -- 2,2 km
  ('d0000000-0000-4000-8000-000000000010', 'bilka', 'salling', 'seed-bilka-hundige',
   'Bilka Hundige', 'Hundige Strandvej 207', '2670', 'Greve', 55.6000, 12.3330), -- 17 km
  ('d0000000-0000-4000-8000-000000000011', 'netto', 'tjek', 'seed-tjek-netto-vesterbrogade',
   'Netto', 'Vesterbrogade 37', '1620', 'København V', 55.6731, 12.5591); -- same store, Tjek id

-- ---------------------------------------------------------------------------------------------
-- Products (EANs seen in food waste). quantity_text/net_* are Open Food Facts data, which the web
-- shows only as "pack size per Open Food Facts" (it may describe another pack).
-- ---------------------------------------------------------------------------------------------
INSERT INTO public.product (id, ean, name, brand, source_category, quantity_text, net_quantity, net_unit, nova_group, nutriscore_grade)
VALUES
  ('c0000000-0000-4000-8000-000000000001', '5701234000011', 'Hakket oksekød 8-12%', NULL,
   'Kød & fisk>Hakket kød>Oksekød', '500 g', 0.5, 'kg', 1, 'b'),
  ('c0000000-0000-4000-8000-000000000002', '5701234000028', 'Økologisk letmælk 0,5%', NULL,
   'Mejeri>Mælk>Letmælk', '1 l', 1, 'l', 1, 'a'),
  ('c0000000-0000-4000-8000-000000000003', '5701234000035', 'Skyr naturel', NULL,
   'Mejeri>Yoghurt & skyr>Skyr', '1 kg', 1, 'kg', 1, 'a'),
  ('c0000000-0000-4000-8000-000000000004', '5701234000042', 'Frilandsæg 10 stk.', NULL,
   'Mejeri>Æg', '10 stk.', 10, 'stk', 1, 'a'),
  ('c0000000-0000-4000-8000-000000000005', '5701234000059', 'Kyllingebrystfilet', NULL,
   'Kød & fisk>Fjerkræ>Kyllingebryst', '600 g', 0.6, 'kg', 1, 'a'),
  ('c0000000-0000-4000-8000-000000000006', '5701234000066', 'Smørbar', NULL,
   'Mejeri>Smør & fedtstoffer>Smørbar', '250 g', 0.25, 'kg', 2, 'e'),
  ('c0000000-0000-4000-8000-000000000007', '5701234000073', 'Mozzarella', NULL,
   'Mejeri>Ost>Mozzarella', NULL, NULL, NULL, 1, 'c'), -- not found in Open Food Facts
  ('c0000000-0000-4000-8000-000000000008', '5701234000080', 'Hakket grisekød 8-12%', NULL,
   'Kød & fisk>Hakket kød>Grisekød', '500 g', 0.5, 'kg', 1, 'b');

INSERT INTO public.product_reference_price (product_id, chain_id, price, first_seen_at, last_seen_at, observations)
VALUES
  ('c0000000-0000-4000-8000-000000000001', 'netto', 42.95, now() - interval '120 days', now() - interval '41 days', 50),
  ('c0000000-0000-4000-8000-000000000001', 'netto', 44.95, now() - interval '40 days', now(), 31),
  ('c0000000-0000-4000-8000-000000000001', 'foetex', 46.95, now() - interval '30 days', now() - interval '2 days', 9),
  ('c0000000-0000-4000-8000-000000000002', 'foetex', 13.95, now() - interval '25 days', now(), 12),
  ('c0000000-0000-4000-8000-000000000003', 'netto', 22.95, now() - interval '60 days', now(), 44);

-- ---------------------------------------------------------------------------------------------
-- Listings. Netto's current offer week runs from two days ago until four days ahead.
-- Columns: id, source, source_item_id, chain, store, catalog, kind, title, description,
--          product, price, reference price, unit, size_min, size_max, member_only,
--          max_per_customer, valid_from, valid_to, raw object, extra
-- ---------------------------------------------------------------------------------------------
INSERT INTO public.listing (id, source, source_item_id, chain_id, store_id, catalog_id, kind, title,
                            description, product_id, price, reference_price, unit, size_min, size_max,
                            member_only, max_per_customer, valid_from, valid_to, raw_object_id, extra)
VALUES
  -- Netto, current week ------------------------------------------------------------------------
  ('a0000000-0000-4000-8000-000000000001', 'tjek', 'seed-n01', 'netto', NULL, 'seed-netto-uge', 'offer',
   'Hakket grisekød 8-12%', '1 kg. Dansk. Max. 4 stk. pr. kunde pr. dag', NULL, 33.33, NULL, 'kg', 1, 1,
   false, 4, pg_temp.day(-2), pg_temp.day_end(4), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000002', 'tjek', 'seed-n02', 'netto', NULL, 'seed-netto-uge', 'offer',
   'Hakket oksekød 14-18%', '375-500 g. Frit valg', NULL, 27.00, NULL, 'kg', 0.375, 0.5,
   false, NULL, pg_temp.day(-2), pg_temp.day_end(4), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000003', 'tjek', 'seed-n03', 'netto', NULL, 'seed-netto-uge', 'offer',
   'Hakket oksekød 8-12%', '500 g. Normalpris 44,95', NULL, 35.00, NULL, 'kg', 0.5, 0.5,
   false, NULL, pg_temp.day(-2), pg_temp.day_end(4), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000004', 'tjek', 'seed-n04', 'netto', NULL, 'seed-netto-uge', 'offer',
   'Frilandsæg 10 stk.', 'Str. M/L', NULL, 25.00, NULL, 'stk', 10, 10,
   false, NULL, pg_temp.day(-2), pg_temp.day_end(4), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000005', 'tjek', 'seed-n05', 'netto', NULL, 'seed-netto-uge', 'offer',
   'Letmælk 1 l', '0,5 % fedt. Normalpris 11,95. Netto+ pris', NULL, 9.95, NULL, 'l', 1, 1,
   true, 6, pg_temp.day(-2), pg_temp.day_end(4), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000006', 'tjek', 'seed-n06', 'netto', NULL, 'seed-netto-uge', 'offer',
   'Danbo 45+ i skiver', 'Mellemlagret. 1 kg. Pr. kg 59,00', NULL, 59.00, NULL, 'kg', 1, 1,
   false, NULL, pg_temp.day(-2), pg_temp.day_end(4), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000007', 'tjek', 'seed-n07', 'netto', NULL, 'seed-netto-uge', 'offer',
   'Skyr eller græsk yoghurt', '1 kg. Naturel. Frit valg', NULL, 20.00, NULL, 'kg', 1, 1,
   false, NULL, pg_temp.day(-2), pg_temp.day_end(4), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000008', 'tjek', 'seed-n08', 'netto', NULL, 'seed-netto-uge', 'offer',
   'Kyllingebrystfilet', '900 g. Frost', NULL, 45.00, NULL, 'kg', 0.9, 0.9,
   false, NULL, pg_temp.day(-2), pg_temp.day_end(4), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000009', 'tjek', 'seed-n09', 'netto', NULL, 'seed-netto-uge', 'offer',
   'Kikærter på dåse, 4 stk.', 'Pr. stk. 5,00', NULL, 20.00, NULL, NULL, NULL, NULL,
   false, NULL, pg_temp.day(-2), pg_temp.day_end(4), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000010', 'tjek', 'seed-n10', 'netto', NULL, 'seed-netto-uge', 'offer',
   'Hakkede tomater', '400 g', NULL, 5.00, NULL, 'kg', 0.4, 0.4,
   false, 10, pg_temp.day(-2), pg_temp.day_end(4), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000011', 'tjek', 'seed-n11', 'netto', NULL, 'seed-netto-uge', 'offer',
   'Dansk smør', '250 g. Normalpris 21,95', NULL, 18.00, NULL, 'kg', 0.25, 0.25,
   false, NULL, pg_temp.day(-2), pg_temp.day_end(4), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000012', 'tjek', 'seed-n12', 'netto', NULL, 'seed-netto-naeste-uge', 'offer',
   'Havregryn', '1 kg. Finvalsede', NULL, 10.00, NULL, 'kg', 1, 1,
   false, NULL, pg_temp.day(5), pg_temp.day_end(11), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000013', 'tjek', 'seed-n13', 'netto', NULL, 'seed-netto-uge', 'offer',
   'Grøntsagsfrikadeller', '400 g', NULL, 22.00, NULL, 'kg', 0.4, 0.4,
   false, NULL, pg_temp.day(-2), pg_temp.day_end(4), 'e0000000-0000-4000-8000-000000000001', '{}'),

  -- Netto, earlier offers (history) ------------------------------------------------------------
  ('a0000000-0000-4000-8000-000000000101', 'tjek', 'seed-h01', 'netto', NULL, 'seed-netto-h1', 'offer',
   'Hakket grisekød 8-12%', '1 kg', NULL, 36.65, NULL, 'kg', 1, 1,
   false, NULL, pg_temp.day(-58), pg_temp.day_end(-52), 'e0000000-0000-4000-8000-000000000002', '{}'),
  ('a0000000-0000-4000-8000-000000000102', 'tjek', 'seed-h02', 'netto', NULL, 'seed-netto-h2', 'offer',
   'Hakket grisekød 8-12%', '500 g', NULL, 19.98, NULL, 'kg', 0.5, 0.5,
   false, NULL, pg_temp.day(-37), pg_temp.day_end(-31), 'e0000000-0000-4000-8000-000000000002', '{}'),
  ('a0000000-0000-4000-8000-000000000103', 'tjek', 'seed-h03', 'netto', NULL, 'seed-netto-h3', 'offer',
   'Hakket grisekød 8-12%', '1 kg', NULL, 34.95, NULL, 'kg', 1, 1,
   false, NULL, pg_temp.day(-23), pg_temp.day_end(-17), 'e0000000-0000-4000-8000-000000000002', '{}'),
  ('a0000000-0000-4000-8000-000000000104', 'tjek', 'seed-h04', 'netto', NULL, 'seed-netto-h2', 'offer',
   'Hakket oksekød 14-18%', '500 g', NULL, 28.26, NULL, 'kg', 0.5, 0.5,
   false, NULL, pg_temp.day(-30), pg_temp.day_end(-24), 'e0000000-0000-4000-8000-000000000002', '{}'),
  ('a0000000-0000-4000-8000-000000000105', 'tjek', 'seed-h05', 'netto', NULL, 'seed-netto-h1', 'offer',
   'Letmælk 1 l', '0,5 % fedt', NULL, 10.50, NULL, 'l', 1, 1,
   false, NULL, pg_temp.day(-44), pg_temp.day_end(-38), 'e0000000-0000-4000-8000-000000000002', '{}'),
  ('a0000000-0000-4000-8000-000000000106', 'tjek', 'seed-h06', 'netto', NULL, 'seed-netto-h3', 'offer',
   'Dansk smør', '250 g', NULL, 19.95, NULL, 'kg', 0.25, 0.25,
   false, NULL, pg_temp.day(-16), pg_temp.day_end(-10), 'e0000000-0000-4000-8000-000000000002', '{}'),

  -- Competitor offers, current week (Tjek) -----------------------------------------------------
  ('a0000000-0000-4000-8000-000000000201', 'tjek', 'seed-c01', 'superbrugsen', NULL, 'seed-sb-uge', 'offer',
   'Hakket grisekød 8-12%', '500 g', NULL, 19.50, NULL, 'kg', 0.5, 0.5,
   false, NULL, pg_temp.day(-1), pg_temp.day_end(5), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000202', 'tjek', 'seed-c02', 'meny', NULL, 'seed-meny-uge', 'offer',
   'Hakket oksekød 14-18%', '1 kg', NULL, 49.90, NULL, 'kg', 1, 1,
   false, NULL, pg_temp.day(-1), pg_temp.day_end(5), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000203', 'tjek', 'seed-c03', 'lidl', NULL, 'seed-lidl-uge', 'offer',
   'Hakket oksekød 8-12%', '500 g', NULL, 29.95, NULL, 'kg', 0.5, 0.5,
   false, NULL, pg_temp.day(-1), pg_temp.day_end(5), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000204', 'tjek', 'seed-c04', 'lidl', NULL, 'seed-lidl-uge', 'offer',
   'Frilandsæg 10 stk.', 'Str. M/L', NULL, 27.50, NULL, 'stk', 10, 10,
   false, NULL, pg_temp.day(-1), pg_temp.day_end(5), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000205', 'tjek', 'seed-c05', 'superbrugsen', NULL, 'seed-sb-uge', 'offer',
   'Danbo 45+ skiver', '500 g', NULL, 32.50, NULL, 'kg', 0.5, 0.5,
   false, NULL, pg_temp.day(-1), pg_temp.day_end(5), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000206', 'tjek', 'seed-c06', 'foetex', NULL, 'seed-foetex-uge', 'offer',
   'Smør', '250 g. Dansk', NULL, 18.90, NULL, 'kg', 0.25, 0.25,
   false, NULL, pg_temp.day(-1), pg_temp.day_end(5), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000207', 'tjek', 'seed-c07', 'kvickly', NULL, 'seed-kvickly-uge', 'offer',
   'Hakkede tomater, 4 x 400 g', '1,6 kg', NULL, 18.00, NULL, 'kg', 1.6, 1.6,
   false, NULL, pg_temp.day(-1), pg_temp.day_end(5), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000208', 'tjek', 'seed-c08', 'lidl', NULL, 'seed-lidl-uge', 'offer',
   'Skyr naturel', '1 kg', NULL, 18.95, NULL, 'kg', 1, 1,
   false, NULL, pg_temp.day(-1), pg_temp.day_end(5), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000209', 'tjek', 'seed-c09', 'meny', NULL, 'seed-meny-uge', 'offer',
   'Letmælk', '1 l', NULL, 9.50, NULL, 'l', 1, 1,
   false, NULL, pg_temp.day(-1), pg_temp.day_end(5), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000210', 'tjek', 'seed-c10', 'lidl', NULL, 'seed-lidl-tidl', 'offer',
   'Hakket grisekød 8-12%', '1 kg', NULL, 35.95, NULL, 'kg', 1, 1,
   false, NULL, pg_temp.day(-30), pg_temp.day_end(-24), 'e0000000-0000-4000-8000-000000000002', '{}'),
  -- Lidl "Fast lav pris": a shelf price printed in the leaflet (kind regular, no deal of its own)
  ('a0000000-0000-4000-8000-000000000211', 'tjek', 'seed-c11', 'lidl', NULL, 'seed-lidl-uge', 'regular',
   'Hakket grisekød 8-12%', '500 g / pk. Pr. kg 47,90 Fast lav pris', NULL, 23.95, NULL, 'kg', 0.5, 0.5,
   false, NULL, pg_temp.day(-200), pg_temp.day_end(40), 'e0000000-0000-4000-8000-000000000001', '{}'),
  ('a0000000-0000-4000-8000-000000000212', 'tjek', 'seed-c12', 'meny', NULL, 'seed-meny-uge', 'offer',
   'Økologisk letmælk, 2 x 1 l', '0,5 % fedt', NULL, 12.00, NULL, 'l', 2, 2,
   false, NULL, pg_temp.day(-1), pg_temp.day_end(5), 'e0000000-0000-4000-8000-000000000001', '{}'),
  -- REMA 1000's leaflet (Tjek); its catalogue twin (308) gets no deal of its own
  ('a0000000-0000-4000-8000-000000000213', 'tjek', 'seed-c13', 'rema1000', NULL, 'seed-rema-uge', 'offer',
   'Hakket grisekød 8-12%', '500 g', NULL, 21.00, NULL, 'kg', 0.5, 0.5,
   false, NULL, pg_temp.day(-1), pg_temp.day_end(5), 'e0000000-0000-4000-8000-000000000001', '{}'),

  -- REMA 1000 shelf prices (open-ended) --------------------------------------------------------
  ('a0000000-0000-4000-8000-000000000301', 'rema', 'seed-r01', 'rema1000', NULL, NULL, 'regular',
   'Hakket grisekød 8-12%', '500 g / Dansk', NULL, 24.95, NULL, 'kg', 0.5, 0.5,
   false, NULL, pg_temp.day(-90), NULL, 'e0000000-0000-4000-8000-000000000003', '{}'),
  ('a0000000-0000-4000-8000-000000000302', 'rema', 'seed-r02', 'rema1000', NULL, NULL, 'regular',
   'Hakket oksekød 14-18%', '500 g / Dansk', NULL, 32.95, NULL, 'kg', 0.5, 0.5,
   false, NULL, pg_temp.day(-90), NULL, 'e0000000-0000-4000-8000-000000000003', '{}'),
  ('a0000000-0000-4000-8000-000000000303', 'rema', 'seed-r03', 'rema1000', NULL, NULL, 'regular',
   'Frilandsæg', '10 stk. / Str. M/L', NULL, 29.50, NULL, 'stk', 10, 10,
   false, NULL, pg_temp.day(-90), NULL, 'e0000000-0000-4000-8000-000000000003', '{}'),
  ('a0000000-0000-4000-8000-000000000304', 'rema', 'seed-r04', 'rema1000', NULL, NULL, 'regular',
   'Letmælk', '1 ltr. / 0,5 %', NULL, 10.95, NULL, 'l', 1, 1,
   false, NULL, pg_temp.day(-90), NULL, 'e0000000-0000-4000-8000-000000000003', '{}'),
  ('a0000000-0000-4000-8000-000000000305', 'rema', 'seed-r05', 'rema1000', NULL, NULL, 'regular',
   'Danbo 45+ skiver', '450 g / Mellemlagret', NULL, 35.98, NULL, 'kg', 0.45, 0.45,
   false, NULL, pg_temp.day(-90), NULL, 'e0000000-0000-4000-8000-000000000003', '{}'),
  ('a0000000-0000-4000-8000-000000000306', 'rema', 'seed-r06', 'rema1000', NULL, NULL, 'regular',
   'Smør', '250 g / Dansk', NULL, 19.95, NULL, 'kg', 0.25, 0.25,
   false, NULL, pg_temp.day(-90), NULL, 'e0000000-0000-4000-8000-000000000003', '{}'),
  ('a0000000-0000-4000-8000-000000000307', 'rema', 'seed-r07', 'rema1000', NULL, NULL, 'regular',
   'Hakket oksekød 8-12%', '500 g / Dansk', NULL, 39.95, NULL, 'kg', 0.5, 0.5,
   false, NULL, pg_temp.day(-90), NULL, 'e0000000-0000-4000-8000-000000000003', '{}'),

  -- REMA 1000 catalogue campaigns: in the leaflet too (308), in-store only (309), earlier (310)
  ('a0000000-0000-4000-8000-000000000308', 'rema', 'seed-r01', 'rema1000', NULL, NULL, 'offer',
   'Hakket grisekød 8-12%', '500 g / Dansk', NULL, 21.00, NULL, 'kg', 0.5, 0.5,
   false, NULL, pg_temp.day(-1), pg_temp.day_end(5), 'e0000000-0000-4000-8000-000000000003', '{}'),
  ('a0000000-0000-4000-8000-000000000309', 'rema', 'seed-r04', 'rema1000', NULL, NULL, 'offer',
   'Letmælk', '1 ltr. / 0,5 %', NULL, 9.00, NULL, 'l', 1, 1,
   false, NULL, pg_temp.day(-1), pg_temp.day_end(5), 'e0000000-0000-4000-8000-000000000003', '{}'),
  ('a0000000-0000-4000-8000-000000000310', 'rema', 'seed-r04', 'rema1000', NULL, NULL, 'offer',
   'Letmælk', '1 ltr. / 0,5 %', NULL, 9.50, NULL, 'l', 1, 1,
   false, NULL, pg_temp.day(-40), pg_temp.day_end(-34), 'e0000000-0000-4000-8000-000000000003', '{}'),

  -- Salling food waste (clearances in specific stores) -----------------------------------------
  -- extra.image: real Salling CDN URLs (pictures of other products; they only exercise the
  -- layout), the placeholder ending in /image (w04) and no image at all (w08). w05 is sold by
  -- weight (no size in the name, so no unit or unit price); w08's product has no Open Food Facts
  -- size.
  ('a0000000-0000-4000-8000-000000000401', 'salling_food_waste', 'seed-w01', 'netto',
   'd0000000-0000-4000-8000-000000000001', NULL, 'clearance', 'HAKKET OKSEKØD 8-12%', '',
   'c0000000-0000-4000-8000-000000000001', 24.00, 44.95, 'kg', 0.5, 0.5, false, NULL,
   now() - interval '3 hours', now() + interval '10 hours', 'e0000000-0000-4000-8000-000000000004',
   '{"stock": 3, "stock_unit": "each", "percent_discount": 46.6,
     "image": "https://digitalassets.sallinggroup.com/image/upload/e_trim/c_limit,e_sharpen:80,f_auto,q_auto,w_400,h_400/64b99ee6-cc51-4b09-aa1b-29b6ac50231e"}'),
  ('a0000000-0000-4000-8000-000000000402', 'salling_food_waste', 'seed-w02', 'foetex',
   'd0000000-0000-4000-8000-000000000006', NULL, 'clearance', 'ØKO LETMÆLK 0,5% 1L', '',
   'c0000000-0000-4000-8000-000000000002', 7.00, 13.95, 'l', 1, 1, false, NULL,
   now() - interval '2 hours', now() + interval '12 hours', 'e0000000-0000-4000-8000-000000000004',
   '{"stock": 6, "stock_unit": "each", "percent_discount": 49.8,
     "image": "https://digitalassets.sallinggroup.com/image/upload/e_trim/c_limit,e_sharpen:80,f_auto,q_auto,w_400,h_400/fb2b2729-a8c5-41b9-bcb6-1b37987787ac"}'),
  ('a0000000-0000-4000-8000-000000000403', 'salling_food_waste', 'seed-w03', 'netto',
   'd0000000-0000-4000-8000-000000000002', NULL, 'clearance', 'SKYR NATUREL 1KG', '',
   'c0000000-0000-4000-8000-000000000003', 12.00, 22.95, 'kg', 1, 1, false, NULL,
   now() - interval '5 hours', now() + interval '1 day', 'e0000000-0000-4000-8000-000000000004',
   '{"stock": 2, "stock_unit": "each", "percent_discount": 47.7,
     "image": "https://digitalassets.sallinggroup.com/image/upload/e_trim/c_limit,e_sharpen:80,f_auto,q_auto,w_400,h_400/950733da79a4a77a10477bf2fbed3ae9"}'),
  ('a0000000-0000-4000-8000-000000000404', 'salling_food_waste', 'seed-w04', 'foetex',
   'd0000000-0000-4000-8000-000000000006', NULL, 'clearance', 'FRILANDSÆG 10 STK', '',
   'c0000000-0000-4000-8000-000000000004', 18.00, 32.95, 'stk', 10, 10, false, NULL,
   now() - interval '4 hours', now() + interval '2 days', 'e0000000-0000-4000-8000-000000000004',
   '{"stock": 4, "stock_unit": "each", "percent_discount": 45.4,
     "image": "https://digitalassets.sallinggroup.com/image/upload/e_trim/c_limit,e_sharpen:80,f_auto,q_auto,w_400,h_400/image"}'), -- Salling's placeholder: image_url is null
  ('a0000000-0000-4000-8000-000000000405', 'salling_food_waste', 'seed-w05', 'netto',
   'd0000000-0000-4000-8000-000000000001', NULL, 'clearance', 'KYLLINGEBRYSTFILET', '',
   'c0000000-0000-4000-8000-000000000005', 39.00, 69.95, NULL, NULL, NULL, false, NULL,
   now() - interval '1 hour', now() + interval '9 hours', 'e0000000-0000-4000-8000-000000000004',
   '{"stock": 1.2, "stock_unit": "kg", "percent_discount": 44.2,
     "image": "https://digitalassets.sallinggroup.com/image/upload/e_trim/c_limit,e_sharpen:80,f_auto,q_auto,w_400,h_400/0f52621552c918ea2deefcc9fd5d54aa"}'), -- sold by weight: size unknown
  ('a0000000-0000-4000-8000-000000000406', 'salling_food_waste', 'seed-w06', 'foetex',
   'd0000000-0000-4000-8000-000000000006', NULL, 'clearance', 'SMØRBAR 250G', '',
   'c0000000-0000-4000-8000-000000000006', 10.00, 21.95, 'kg', 0.25, 0.25, false, NULL,
   now() - interval '1 hour', now() + interval '1 day', 'e0000000-0000-4000-8000-000000000004',
   '{"stock": 8, "stock_unit": "each", "percent_discount": 54.4,
     "image": "https://digitalassets.sallinggroup.com/image/upload/e_trim/c_limit,e_sharpen:80,f_auto,q_auto,w_400,h_400/4ef94c78cf76398f2ae8f7bd4fdc8750"}'),
  ('a0000000-0000-4000-8000-000000000407', 'salling_food_waste', 'seed-w07', 'bilka',
   'd0000000-0000-4000-8000-000000000010', NULL, 'clearance', 'HAKKET GRISEKØD 8-12%', '',
   'c0000000-0000-4000-8000-000000000008', 15.00, 29.95, 'kg', 0.5, 0.5, false, NULL,
   now() - interval '2 hours', now() + interval '8 hours', 'e0000000-0000-4000-8000-000000000004',
   '{"stock": 10, "stock_unit": "each", "percent_discount": 49.9,
     "image": "https://digitalassets.sallinggroup.com/image/upload/e_trim/c_limit,e_sharpen:80,f_auto,q_auto,w_400,h_400/629ca0c2-555a-42f0-9afd-7905e77094aa"}'),
  ('a0000000-0000-4000-8000-000000000408', 'salling_food_waste', 'seed-w08', 'netto',
   'd0000000-0000-4000-8000-000000000002', NULL, 'clearance', 'MOZZARELLA 125G', '',
   'c0000000-0000-4000-8000-000000000007', 6.00, 11.95, 'kg', 0.125, 0.125, false, NULL,
   now() - interval '6 hours', now() + interval '1 day 6 hours', 'e0000000-0000-4000-8000-000000000004',
   '{"stock": 5, "stock_unit": "each", "percent_discount": 49.8}');

-- What Salling's API said: the clearance label code and the product's EAN (`listing.product_key`
-- is `ean:<product_code>` for clearances with a product).
UPDATE public.listing l
SET extra = l.extra || jsonb_build_object('product_code', p.ean, 'offer_ean', '24' || right(p.ean, 11))
FROM public.product p
WHERE p.id = l.product_id AND l.source = 'salling_food_waste';

-- Unit prices follow the PoC rule (architecture §5).
UPDATE public.listing
SET unit_price_min = round(price / size_max, 4),
    unit_price_max = round(price / size_min, 4)
WHERE size_min > 0 AND size_max > 0;

-- ---------------------------------------------------------------------------------------------
-- Classifications under the current matcher release.
-- ---------------------------------------------------------------------------------------------
CREATE TEMP TABLE seed_class (
  class_key text PRIMARY KEY, type_id text, type_label text, group_name text, class_label text,
  attrs jsonb, is_exact bool, is_healthy bool
) ON COMMIT DROP;

INSERT INTO seed_class VALUES
  ('hakket_grisekød|fedt=8-12%|øko=nej|forarbejdet=nej', 'hakket_grisekød', 'Hakket grisekød', 'Kød',
   'Hakket grisekød, 8-12%', '{"fedt": "8-12%", "øko": "nej"}', true, true),
  ('hakket_oksekød|fedt=13-20%|øko=nej|forarbejdet=nej', 'hakket_oksekød', 'Hakket oksekød', 'Kød',
   'Hakket oksekød, 13-20%', '{"fedt": "13-20%", "øko": "nej"}', true, true),
  ('hakket_oksekød|fedt=8-12%|øko=nej|forarbejdet=nej', 'hakket_oksekød', 'Hakket oksekød', 'Kød',
   'Hakket oksekød, 8-12%', '{"fedt": "8-12%", "øko": "nej"}', true, true),
  ('kyllingebryst|tilsat_vand=?|forarbejdet=nej', 'kyllingebryst', 'Kyllingebryst(filet)', 'Kød',
   'Kyllingebryst(filet), tilsat vand?', '{"tilsat_vand": "?"}', false, true),
  ('kyllingebryst|tilsat_vand=nej|forarbejdet=nej', 'kyllingebryst', 'Kyllingebryst(filet)', 'Kød',
   'Kyllingebryst(filet), uden tilsat vand', '{"tilsat_vand": "nej"}', true, true),
  ('æg|produktion=frilands|øko=nej|forarbejdet=nej', 'æg', 'Æg', 'Æg',
   'Æg, frilands', '{"produktion": "frilands", "øko": "nej"}', true, true),
  ('mælk|mælketype=letmælk|øko=nej|laktosefri=nej|forarbejdet=nej', 'mælk', 'Mælk', 'Mejeri',
   'Mælk, letmælk', '{"mælketype": "letmælk", "øko": "nej", "laktosefri": "nej"}', true, true),
  ('mælk|mælketype=letmælk|øko=ja|laktosefri=nej|forarbejdet=nej', 'mælk', 'Mælk', 'Mejeri',
   'Mælk, letmælk, økologisk', '{"mælketype": "letmælk", "øko": "ja", "laktosefri": "nej"}', true, true),
  ('fast_ost|form=skiver|forarbejdet=nej', 'fast_ost', 'Fast ost', 'Mejeri',
   'Fast ost, skiver', '{"form": "skiver"}', true, true),
  ('skyr|smag=naturel|forarbejdet=nej', 'skyr', 'Skyr', 'Mejeri',
   'Skyr, naturel', '{"smag": "naturel"}', true, true),
  ('græsk_yoghurt|smag=naturel|forarbejdet=nej', 'græsk_yoghurt', 'Græsk yoghurt', 'Mejeri',
   'Græsk yoghurt, naturel', '{"smag": "naturel"}', true, true),
  ('smør|øko=nej|forarbejdet=nej', 'smør', 'Smør', 'Mejeri', 'Smør', '{"øko": "nej"}', true, true),
  ('smørbar|øko=nej|forarbejdet=nej', 'smørbar', 'Smørbar (blandingsprodukt)', 'Mejeri',
   'Smørbar (blandingsprodukt)', '{"øko": "nej"}', true, false),
  ('mozzarella|øko=nej|forarbejdet=nej', 'mozzarella', 'Mozzarella', 'Mejeri',
   'Mozzarella', '{"øko": "nej"}', true, true),
  ('kikærter|form=dåse|forarbejdet=nej', 'kikærter', 'Kikærter', 'Kolonial',
   'Kikærter, dåse', '{"form": "dåse"}', true, true),
  ('hakkede_tomater|forarbejdet=nej', 'hakkede_tomater', 'Hakkede tomater (dåse)', 'Kolonial',
   'Hakkede tomater (dåse)', '{}', true, true),
  ('havregryn|øko=nej|forarbejdet=nej', 'havregryn', 'Havregryn', 'Kolonial',
   'Havregryn', '{"øko": "nej"}', true, true);

-- (listing suffix, variant, class key, offer variants, same-class variants, notes)
CREATE TEMP TABLE seed_listing_class (
  n int, variant_index smallint, class_key text, offer_variants smallint,
  same_class_variants smallint, notes text[]
) ON COMMIT DROP;

INSERT INTO seed_listing_class VALUES
  (1, 0, 'hakket_grisekød|fedt=8-12%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (2, 0, 'hakket_oksekød|fedt=13-20%|øko=nej|forarbejdet=nej', 1, 1, '{"pakningsstørrelse 375-500 g"}'),
  (3, 0, 'hakket_oksekød|fedt=8-12%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (4, 0, 'æg|produktion=frilands|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (5, 0, 'mælk|mælketype=letmælk|øko=nej|laktosefri=nej|forarbejdet=nej', 1, 1, '{"kræver Netto+"}'),
  (6, 0, 'fast_ost|form=skiver|forarbejdet=nej', 1, 1, '{}'),
  (7, 0, 'skyr|smag=naturel|forarbejdet=nej', 2, 1, '{"tilbuddet dækker også græsk yoghurt"}'),
  (7, 1, 'græsk_yoghurt|smag=naturel|forarbejdet=nej', 2, 1, '{"tilbuddet dækker også skyr"}'),
  (8, 0, 'kyllingebryst|tilsat_vand=?|forarbejdet=nej', 1, 1, '{"tilsat vand ikke oplyst"}'),
  (9, 0, 'kikærter|form=dåse|forarbejdet=nej', 1, 1, '{"mængde ikke oplyst"}'),
  (10, 0, 'hakkede_tomater|forarbejdet=nej', 1, 1, '{}'),
  (11, 0, 'smør|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (12, 0, 'havregryn|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (101, 0, 'hakket_grisekød|fedt=8-12%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (102, 0, 'hakket_grisekød|fedt=8-12%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (103, 0, 'hakket_grisekød|fedt=8-12%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (104, 0, 'hakket_oksekød|fedt=13-20%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (105, 0, 'mælk|mælketype=letmælk|øko=nej|laktosefri=nej|forarbejdet=nej', 1, 1, '{}'),
  (106, 0, 'smør|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (201, 0, 'hakket_grisekød|fedt=8-12%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (202, 0, 'hakket_oksekød|fedt=13-20%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (203, 0, 'hakket_oksekød|fedt=8-12%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (204, 0, 'æg|produktion=frilands|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (205, 0, 'fast_ost|form=skiver|forarbejdet=nej', 1, 1, '{}'),
  (206, 0, 'smør|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (207, 0, 'hakkede_tomater|forarbejdet=nej', 1, 1, '{}'),
  (208, 0, 'skyr|smag=naturel|forarbejdet=nej', 1, 1, '{}'),
  (209, 0, 'mælk|mælketype=letmælk|øko=nej|laktosefri=nej|forarbejdet=nej', 1, 1, '{}'),
  (210, 0, 'hakket_grisekød|fedt=8-12%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (211, 0, 'hakket_grisekød|fedt=8-12%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (212, 0, 'mælk|mælketype=letmælk|øko=ja|laktosefri=nej|forarbejdet=nej', 1, 1, '{}'),
  (213, 0, 'hakket_grisekød|fedt=8-12%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (301, 0, 'hakket_grisekød|fedt=8-12%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (302, 0, 'hakket_oksekød|fedt=13-20%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (303, 0, 'æg|produktion=frilands|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (304, 0, 'mælk|mælketype=letmælk|øko=nej|laktosefri=nej|forarbejdet=nej', 1, 1, '{}'),
  (305, 0, 'fast_ost|form=skiver|forarbejdet=nej', 1, 1, '{}'),
  (306, 0, 'smør|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (307, 0, 'hakket_oksekød|fedt=8-12%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (308, 0, 'hakket_grisekød|fedt=8-12%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (309, 0, 'mælk|mælketype=letmælk|øko=nej|laktosefri=nej|forarbejdet=nej', 1, 1, '{}'),
  (310, 0, 'mælk|mælketype=letmælk|øko=nej|laktosefri=nej|forarbejdet=nej', 1, 1, '{}'),
  (401, 0, 'hakket_oksekød|fedt=8-12%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (402, 0, 'mælk|mælketype=letmælk|øko=ja|laktosefri=nej|forarbejdet=nej', 1, 1, '{}'),
  (403, 0, 'skyr|smag=naturel|forarbejdet=nej', 1, 1, '{}'),
  (404, 0, 'æg|produktion=frilands|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (405, 0, 'kyllingebryst|tilsat_vand=nej|forarbejdet=nej', 1, 1, '{"type fundet via kategori"}'),
  (406, 0, 'smørbar|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (407, 0, 'hakket_grisekød|fedt=8-12%|øko=nej|forarbejdet=nej', 1, 1, '{}'),
  (408, 0, 'mozzarella|øko=nej|forarbejdet=nej', 1, 1, '{}');

INSERT INTO public.classification (listing_id, matcher_version, variant_index, type_id, type_label,
                                   group_name, attrs, class_key, class_label, is_exact, is_healthy,
                                   offer_variants, same_class_variants, notes, source_hint)
SELECT ('a0000000-0000-4000-8000-' || lpad(lc.n::text, 12, '0'))::uuid, mr.version,
       lc.variant_index, c.type_id, c.type_label, c.group_name, c.attrs, c.class_key, c.class_label,
       c.is_exact, c.is_healthy, lc.offer_variants, lc.same_class_variants, lc.notes,
       CASE WHEN lc.n BETWEEN 400 AND 499 THEN 'category' ELSE 'text' END
FROM seed_listing_class lc
JOIN seed_class c USING (class_key)
CROSS JOIN public.matcher_release mr
WHERE mr.is_current;

-- ---------------------------------------------------------------------------------------------
-- Deals for the started offers of every chain (upcoming offers stay "pending"; the REMA 1000
-- catalogue campaign 308 is in the leaflet as 213, so it gets none). References are every
-- same-class listing: other chains' current offers, shelf prices of any chain and the chain's own
-- earlier offers (a simplified deals/compute.py).
-- ---------------------------------------------------------------------------------------------
INSERT INTO public.deal (listing_id, variant_index, matcher_version, class_key,
                         netto_unit_price_worst, netto_unit_price_best, price_applies, "references")
SELECT c.listing_id, c.variant_index, c.matcher_version, c.class_key,
       l.unit_price_max, l.unit_price_min, c.same_class_variants >= c.offer_variants,
       CASE WHEN NOT c.is_exact THEN '[]'::jsonb ELSE COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
                  'kind', CASE WHEN r.kind = 'regular' THEN 'regular'
                               WHEN r.chain_id = l.chain_id THEN 'history'
                               ELSE 'offer' END,
                  'chain_id', r.chain_id,
                  'listing_id', r.id,
                  'title', r.title,
                  'unit_price', r.unit_price_min,
                  'unit', r.unit,
                  'valid_from', to_char(r.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                  'valid_to', to_char(r.valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                  'member_only', r.member_only)
                ORDER BY r.unit_price_min)
         FROM public.listing r
         JOIN public.classification rc
           ON rc.listing_id = r.id AND rc.matcher_version = c.matcher_version
         WHERE rc.class_key = c.class_key
           AND r.id <> l.id
           AND r.unit = l.unit
           AND r.unit_price_min IS NOT NULL
           AND rc.same_class_variants >= rc.offer_variants
           AND (r.kind = 'regular'
                OR (r.kind = 'offer' AND r.chain_id = l.chain_id AND r.valid_to < l.valid_from)
                OR (r.kind = 'offer' AND r.chain_id <> l.chain_id
                    AND (r.valid_to IS NULL OR r.valid_to >= now())))
       ), '[]'::jsonb) END
FROM public.listing l
JOIN public.classification c ON c.listing_id = l.id
JOIN public.matcher_release mr ON mr.version = c.matcher_version AND mr.is_current
WHERE l.kind = 'offer' AND l.source IN ('tjek', 'rema') AND c.is_healthy
  AND l.id <> 'a0000000-0000-4000-8000-000000000308'
  AND l.valid_from <= now() AND l.valid_to >= now();

-- An EAN-level reference price (Salling originalPrice) for the milk offer.
UPDATE public.deal
SET "references" = "references" || jsonb_build_array(jsonb_build_object(
      'kind', 'ean_reference', 'chain_id', 'netto', 'listing_id', NULL,
      'title', 'Letmælk 0,5 % 1 l (normalpris i Netto)', 'unit_price', 11.95, 'unit', 'l',
      'valid_from', NULL, 'valid_to', NULL, 'member_only', false))
WHERE listing_id = 'a0000000-0000-4000-8000-000000000005';

-- ---------------------------------------------------------------------------------------------
-- Review queue.
-- ---------------------------------------------------------------------------------------------
INSERT INTO public.review_item (listing_id, reason, status, created_at)
VALUES
  ('a0000000-0000-4000-8000-000000000008', 'unknown_key_attribute', 'open', now() - interval '3 hours'),
  ('a0000000-0000-4000-8000-000000000007', 'ambiguous_offer', 'open', now() - interval '3 hours'),
  ('a0000000-0000-4000-8000-000000000013', 'unrecognized_staple_word', 'open', now() - interval '3 hours'),
  ('a0000000-0000-4000-8000-000000000009', 'unknown_key_attribute', 'fixed', now() - interval '2 days');

-- ---------------------------------------------------------------------------------------------
-- Local read-only login for the web app (dev only): member of the migration's `web_readonly`
-- role, so it can read the `api` views and nothing else. Cluster-wide, created once.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'foodcatch_web') THEN
    CREATE ROLE foodcatch_web LOGIN PASSWORD 'foodcatch_web' IN ROLE web_readonly;
  END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

COMMIT;
