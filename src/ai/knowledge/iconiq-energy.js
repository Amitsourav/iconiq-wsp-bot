/**
 * Iconiq Energy — product & company knowledge base.
 *
 * This is plain text handed to the model as part of the system prompt for
 * direct-message conversations (see ../assistant.js). It is sourced from the
 * company's product datasheet / profile PDF. Keep it in one place so it's
 * easy to update when the datasheet changes — nothing else needs to change.
 */
module.exports = `
COMPANY
- Name: Iconiq Energy (www.iconiqenergy.in)
- What they do: BESS (Battery Energy Storage System) experts in India — hybrid
  inverters, LFP batteries, and BESS, serving Residential, Commercial &
  Industrial (C&I), and Utility customers.
- Vision: Advancing a world powered by smart, sustainable energy.
- Mission: To craft intelligent, high-performance clean energy solutions that
  blend cutting-edge technology with elevated, effortless user experience and
  unlock sustainable independence for all.
- Manufacturing: 2.5 GWh in-house LFP battery manufacturing plant (quality
  control + supply chain resilience).
- Also offers System Integration / EPC service — end-to-end engineering,
  procurement, and construction.
- Certifications: BIS Certified, IEC Certified (plus product-level IEC/EN
  certifications listed per model below).
- Contact: +91 982 115 2633 | connect@iconiqenergy.in | www.iconiqenergy.in

PRODUCT PORTFOLIO OVERVIEW
1. Hybrid Inverters — 3 kW to 30 kW
2. LFP Batteries — Low Voltage (wall/rack mounted) and High Voltage (stacked)
3. BESS — Commercial & Industrial cabinets, and Containerized (MWh-scale)
4. Monitoring platform — Customer App + "Iconiq Care" installer/O&M app

=== 1. HYBRID INVERTERS ===

A) ICE Single Phase Hybrid Inverter Range — 3 kW / 5 kW / 6 kW (low voltage)
   Models: ICE-3.0-SPLV, ICE-5.0-SPLV, ICE-6.0-SPLV
   - DC input up to 18 A per MPPT (high solar input capacity), 2 MPPTs
   - Max PV input power: 4800 W / 8000 W / 9600 W respectively
   - Battery: Li-ion or Lead-acid, 40-60V range
   - Rated output power: 3000 W / 5000 W / 6000 W; backup/EPS port same rating
   - 200% EPS output for 10 seconds (supports heavy load surges)
   - Switching from grid-connected to standalone: <10 ms (instant backup)
   - Up to 6 units in parallel for easy system expansion
   - Max efficiency 97.2-97.6%; Euro efficiency 96.2-96.8%
   - IP66 outdoor-rated, natural convection cooling, operating temp -20 to +60°C
     (derating above 45°C)
   - Dimensions <380*480*250 mm, weight <21 kg
   - Certifications: IEC/EN 62109-1&2, IEC 61000-6-1/6-3, IEC 60529, IEC 60068,
     IEC 61683, G98/G99/G100, CEI-021, IEC 63027

B) ICE Three Phase LV Hybrid Inverter Range — 8 kW / 10 kW / 12 kW (low voltage)
   Models: ICE-8.0-TPLV, ICE-10.0-TPLV, ICE-12.0-TPLV
   - SiC technology, up to 98.2% max efficiency (97.7% Euro efficiency)
   - 3 MPPTs — good for complex/multi-orientation roofs
   - 150-200% PV input ratio for higher generation on cloudy days
   - Up to 6 units in parallel
   - IP65 protection, isolated topology
   - Battery: Lithium-ion / Lead-acid / Sodium-ion (optional), 30-60V, 2 battery
     inputs, 125A x 2 charge/discharge current
   - On-grid rated output: 8/10/12 kW; peak backup power 20 kVA for 10s
   - Switching time <10 ms
   - Communication: LED / WiFi / 4G / Bluetooth / RS485
   - Operating temp -25 to +60°C, altitude up to 4000 m
   - Dimensions 65 x 665 x 165 mm (approx), weight 36 kg, noise <45 dB
   - Certifications: IEC62109-1&2, IEC62040-1, EN61000 series, VDE-AR-N 4105,
     G98/G100, CEI 0-21, AS/NZS4777.2, NRS097-2-1

C) ICE Three Phase HV Hybrid Inverter Range — 15 / 20 / 25 / 30 kW (high voltage)
   Models: ICE-15.0-TPHV, ICE-20.0-TPHV, ICE-25.0-TPHV, ICE-30-TPHV
   - AC-coupled and gen-set ready
   - Connect up to 6 inverters for easy expansion
   - Fully unbalanced 3-phase output — powers heavy/uneven loads seamlessly
   - IP66 outdoor protection (extreme weather)
   - 200% DC/AC ratio for maximum energy harvesting
   - Battery: Lithium-ion, 160-750V range, 1-2 battery inputs depending on model
   - Max PV input power: 30/40/50/60 kW; up to 3 MPPTs; max input voltage 1000V
   - Rated backup peak power: 20-48 kW for <10s depending on model
   - Max efficiency 97.8% across the range
   - Communication with BMS: CAN; interface LED/APP/LCD
   - Operating temp -25 to +60°C, altitude up to 3000 m
   - Dimensions 550 x 800 x 230 mm, weight ~46.5-50 kg
   - Certifications: IEC/EN 62109-1&2, IEC/EN 61000-6 series, IEC 62920,
     EN 50530, CEI 0-21, VDE-AR-N 4105, EN 50549, G99/G100, IEC61727, IEC62116,
     NRS 097-2-1

=== 2. LFP BATTERIES ===

A) Low Voltage Batteries — Wall / Rack Mounted
   Models: ICE-B-5.12, ICE-B-10.24, ICE-B-15.3 (15.36 kWh), ICE-B-20.4 (20.48 kWh)
   - 5.12 kWh modular design; 1-8 units in parallel — up to ~41 kWh
   - Nominal voltage 51.2V, operating range 45.0-56.4V
   - Max output power scales 5/10/15/20 kW across the 1-4 module sizes
   - Cell: 3.2V 100Ah LFP prismatic
   - ≥97% charge/discharge efficiency
   - Enclosure IP21; wall/floor mounted — saves install time & cost
   - Wide operating temperature range: -20°C to 55°C
   - Designed life >15 years, up to 6000 cycles at 80% DOD / 70% EOL (0.5C, 25°C)
   - Communication: CAN/RS485

B) High Voltage Batteries — Stacked (industrial design)
   Models: ICE-B-25.0 (25.60 kWh), ICE-B-35.0 (35.84 kWh), ICE-B-46.0 (46.08 kWh),
   ICE-B-56.0 (56.32 kWh) — built from 100Ah LFP prismatic cell modules, 5 to 11
   modules; nominal voltage 256V-563.2V depending on size
   - Scalable design — the stacked HV platform (100Ah modules) can scale up to
     ~102 kWh with 20 parallel groups; matches 20+ brands of mainstream inverters
   - Self-produced 100Ah LFP prismatic cells — high safety
   - Designed for 15 years / up to 6000 cycles
   - Optional expansion features: anti-theft, fire protection
   - Enclosure IP20, floor installation, CAN communication
   - Operating temp: charge -5 to 50°C, discharge -20 to 50°C (recommended
     15-35°C); altitude up to 4000 m

=== 3. BESS (BATTERY ENERGY STORAGE SYSTEMS) ===

A) Commercial & Industrial BESS — 261 kWh / 522 kWh
   Models: ICE-POD-261, ICE-POD-522
   - Outdoor cabinet integrating batteries, BMS/PCS, smart liquid cooling, and
     fire protection, with isolated electrical and battery compartments
   - AC rated power 125 kW, nominal AC voltage 415V
   - Cell: LFP 314Ah; nominal DC voltage 832V
   - Liquid cooled; DC round-trip efficiency >94%; lifetime 8000 cycles
   - Fire-fighting: temperature/smoke detection, aerosol, flooding
   - IP54, operating temp -30 to 55°C
   - Weight ~2900 kg (261 kWh) / ~5200 kg (522 kWh)
   - Certifications: IEC62619, IEC61000, UL9540(A), UN38.3

B) Containerized BESS — 3 MWh / 4 MWh / 5 MWh
   Models: ICE-POD-3MWh, ICE-POD-4MWh, ICE-POD-5MWh
   - Plug-and-play modular container: batteries, PCS, thermal and fire-safety
     systems in one transportable unit
   - Intelligent liquid cooling extends battery life; supports EMS integration
     (anti-backflow, battery status management)
   - High expansion flexibility — up to 6.25 MWh with modular design
   - Rated AC capacity: 3.34 MWh / 4.18 MWh / 5.016 MWh usable, 2.5 MVA modules
   - Cell: LFP 314Ah; nominal DC voltage ~1331V
   - DC round-trip efficiency >94%; lifetime 8000 cycles
   - Fire-fighting: temperature/smoke detection, aerosol, flooding, alarm bell
     and strobe
   - Weight ~40-49 tons; dimensions ~6058 x 2436 x 2896 mm
   - Certifications: IEC62619, IEC61000, UL9540(A), UN38.3

BESS APPLICATIONS
- AC-Coupled: batteries and solar connected on an AC bus — ideal when solar is
  already installed.
- DC-Coupled: batteries and solar connected on a DC bus via a hybrid inverter —
  ideal for new solar + BESS installs together.
- Used across Home Energy Storage, Commercial & Industrial, and Utility-scale
  applications for: system monitoring, peak shaving, demand management,
  remote O&M, SOH (state-of-health) analysis, and PV-ESS coordination.

=== 4. MONITORING PLATFORM ===
- Customer App (for end users) and "Iconiq Care" (installer/O&M focused app):
  installation documents, installation videos, warranty registration &
  claims, service claims, buy new products, contact us.
- Web/cloud platform covers: Business Operation (BI dashboard), Efficient
  Maintenance (alarm management, ownership, grouping), System Monitoring
  (10-second interval energy flow & graphs, report search/download, device
  categorisation), Device Monitoring (10-second real-time device data,
  remote parameter configuration, historical curves), After-Sales Service
  (warranty period lookup), Organization Management (member/company/installer
  hierarchy management), and Value-Added Services (AI Smart Assistant,
  third-party VPP integration, open northbound integration).

HOW TO ANSWER PRODUCT QUESTIONS
- Match the product family (single-phase LV inverter / three-phase LV inverter
  / three-phase HV inverter / LV battery / HV battery / C&I BESS / containerized
  BESS) to what the person is asking about before quoting numbers.
- If someone gives a load or capacity requirement, suggest the closest matching
  model(s) from the ranges above rather than just listing everything.
- For anything not in this knowledge base — pricing, dealer/installer network,
  stock/lead times, specific project quotations, warranty claim status — say
  plainly that you don't have that on hand and the team will follow up, rather
  than guessing a number.
`;
