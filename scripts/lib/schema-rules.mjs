// Google Search structured-data rules per type (required / recommended / one-of / value formats, doc URL and the
// date the doc was checked), the retired and limited types (references/15 §15) and a JSON-LD graph walker. Pure.
import { compactKey, shingleSet } from './text.mjs';
import { decodeEntities } from './html.mjs';

export const LAST_VERIFIED = '2026-11-02';
const SD = 'https://developers.google.com/search/docs/appearance/structured-data/';
export const POLICY_URL = `${SD}sd-policies`;
export const UPDATES_URL = 'https://developers.google.com/search/updates';
export const SCHEMA_VALIDATOR_URL = 'https://validator.schema.org/';
export const RICH_RESULTS_TEST_URL = 'https://search.google.com/test/rich-results';
export const ORGANIZATION_DOC = `${SD}organization`;

// ---------- type families ----------
export const ARTICLE_TYPES = new Set(['Article', 'NewsArticle', 'BlogPosting', 'LiveBlogPosting', 'TechArticle', 'ScholarlyArticle', 'Report', 'AnalysisNewsArticle', 'AskPublicNewsArticle', 'BackgroundNewsArticle', 'OpinionNewsArticle', 'ReportageNewsArticle', 'ReviewNewsArticle', 'SatiricalArticle', 'AdvertiserContentArticle']);
export const LOCAL_BUSINESS_TYPES = new Set(`LocalBusiness AnimalShelter ArchiveOrganization AutomotiveBusiness AutoBodyShop AutoDealer AutoPartsStore AutoRental AutoRepair AutoWash GasStation MotorcycleDealer MotorcycleRepair ChildCare Dentist DryCleaningOrLaundry EmergencyService FireStation Hospital PoliceStation EmploymentAgency EntertainmentBusiness AdultEntertainment AmusementPark ArtGallery Casino ComedyClub MovieTheater NightClub FinancialService AccountingService AutomatedTeller BankOrCreditUnion InsuranceAgency FoodEstablishment Bakery BarOrPub Brewery CafeOrCoffeeShop Distillery FastFoodRestaurant IceCreamShop Restaurant Winery GovernmentOffice PostOffice HealthAndBeautyBusiness BeautySalon DaySpa HairSalon HealthClub NailSalon TattooParlor HomeAndConstructionBusiness Electrician GeneralContractor HVACBusiness HousePainter Locksmith MovingCompany Plumber RoofingContractor InternetCafe LegalService Attorney Notary Library LodgingBusiness BedAndBreakfast Campground Hostel Hotel Motel Resort VacationRental MedicalBusiness CommunityHealth DiagnosticLab MedicalClinic Optician Pharmacy Physician PhysiciansOffice ProfessionalService RadioStation RealEstateAgent RecyclingCenter SelfStorage ShoppingCenter SportsActivityLocation BowlingAlley ExerciseGym GolfCourse PublicSwimmingPool SkiResort SportsClub StadiumOrArena TennisComplex Store BikeStore BookStore ClothingStore ComputerStore ConvenienceStore DepartmentStore ElectronicsStore Florist FurnitureStore GardenStore GroceryStore HardwareStore HobbyShop HomeGoodsStore JewelryStore LiquorStore MensClothingStore MobilePhoneStore MovieRentalStore MusicStore OfficeEquipmentStore OutletStore PawnShop PetStore ShoeStore SportingGoodsStore TireShop ToyStore WholesaleStore TelevisionStation TouristInformationCenter TravelAgency`.split(/\s+/));
export const ORGANIZATION_TYPES = new Set(['Organization', 'Corporation', 'NGO', 'EducationalOrganization', 'CollegeOrUniversity', 'ElementarySchool', 'HighSchool', 'MiddleSchool', 'Preschool', 'School', 'GovernmentOrganization', 'MedicalOrganization', 'NewsMediaOrganization', 'OnlineBusiness', 'OnlineStore', 'SportsOrganization', 'SportsTeam', 'PerformingGroup', 'MusicGroup', 'DanceGroup', 'TheaterGroup', 'Airline', 'Consortium', 'FundingScheme', 'LibrarySystem', 'PoliticalParty', 'ResearchOrganization', 'WorkersUnion', 'Cooperative', 'SearchRescueOrganization', ...LOCAL_BUSINESS_TYPES]);
export const PRODUCT_TYPES = new Set(['Product', 'IndividualProduct', 'ProductModel', 'SomeProducts']);
export const SOFTWARE_TYPES = new Set(['SoftwareApplication', 'MobileApplication', 'WebApplication', 'VideoGame']);
export const WEBPAGE_TYPES = new Set(['WebPage', 'AboutPage', 'CheckoutPage', 'CollectionPage', 'ContactPage', 'FAQPage', 'ItemPage', 'MedicalWebPage', 'ProfilePage', 'QAPage', 'RealEstateListing', 'SearchResultsPage']);
export const REVIEW_TYPES = new Set(['Review', 'CriticReview', 'EmployerReview', 'UserReview', 'Recommendation']);
const VEHICLE_TYPES = new Set(['Car', 'Vehicle', 'Motorcycle', 'MotorizedBicycle', 'BusOrCoach']);

/** Properties whose object values point at another entity: those nodes only get a reference sanity check. */
export const REFERENCE_PROPS = new Set(['author', 'creator', 'publisher', 'provider', 'brand', 'manufacturer', 'seller', 'organizer', 'performer', 'founder', 'founders', 'member', 'members', 'employee', 'employees', 'worksFor', 'parentOrganization', 'subOrganization', 'sponsor', 'funder', 'copyrightHolder', 'sourceOrganization', 'isPartOf', 'about', 'mentions', 'mainEntityOfPage', 'inDefinedTermSet', 'publishedBy', 'affiliation', 'alumniOf', 'memberOf', 'itemReviewed', 'contributor', 'editor', 'accountablePerson', 'producer', 'translator', 'recipient', 'isVariantOf', 'itemOffered']);

export const APP_CATEGORIES = new Set(['GameApplication', 'SocialNetworkingApplication', 'TravelApplication', 'ShoppingApplication', 'SportsApplication', 'LifestyleApplication', 'BusinessApplication', 'DesignApplication', 'DeveloperApplication', 'DriverApplication', 'EducationalApplication', 'HealthApplication', 'FinanceApplication', 'SecurityApplication', 'BrowserApplication', 'CommunicationApplication', 'DesktopEnhancementApplication', 'EntertainmentApplication', 'MultimediaApplication', 'HomeApplication', 'UtilitiesApplication', 'ReferenceApplication']);
export const GOOGLE_AVAILABILITY = new Set(['BackOrder', 'Discontinued', 'InStock', 'InStoreOnly', 'LimitedAvailability', 'OnlineOnly', 'OutOfStock', 'PreOrder', 'PreSale', 'SoldOut']);
const SCHEMA_AVAILABILITY = new Set([...GOOGLE_AVAILABILITY, 'MadeToOrder', 'Reserved']);
const ITEM_CONDITIONS = new Set(['NewCondition', 'UsedCondition', 'RefurbishedCondition', 'DamagedCondition']);
const EVENT_STATUS = new Set(['EventScheduled', 'EventCancelled', 'EventPostponed', 'EventRescheduled', 'EventMovedOnline']);
const ATTENDANCE_MODES = new Set(['OfflineEventAttendanceMode', 'OnlineEventAttendanceMode', 'MixedEventAttendanceMode']);
const DAYS = new Set(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'PublicHolidays']);
// Active ISO 4217 codes (plus funds and precious-metal codes); anything else is reported as a warning.
export const ISO_4217 = new Set(`AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAF XAG XAU XCD XCG XDR XOF XPD XPF XPT XSU XUA YER ZAR ZMW ZWG ZWL`.split(/\s+/));

// ---------- JSON-LD helpers ----------
export const normType = (t) => String(t || '').trim().replace(/^https?:\/\/schema\.org\//i, '').replace(/^schema:/i, '');

export function typesOf(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  return [].concat(node['@type'] || []).filter((t) => typeof t === 'string').map(normType).filter(Boolean);
}

/** {"@id"} or {"@id","@type"} only: a pointer to an entity defined elsewhere. */
export function isReference(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node['@id'] !== 'string') return false;
  return Object.keys(node).every((k) => k === '@id' || k === '@type');
}

export const literal = (v) => (v && typeof v === 'object' && !Array.isArray(v) && '@value' in v ? v['@value'] : v);
const present = (v) => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim()) && !(Array.isArray(v) && !v.length);

/** "$['@graph'][2].offers.price" */
export function jsonPath(parts) {
  let s = '$';
  for (const p of parts) {
    if (typeof p === 'number') s += `[${p}]`;
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) s += `.${p}`;
    else s += `['${String(p).replace(/'/g, "\\'")}']`;
  }
  return s;
}

/**
 * Visit every object node: fn(node, {path, parentProp, topLevel, parentTypes}). Root objects, root array items and
 * @graph members are top level; @value literals are not visited.
 */
export function walkJsonLd(data, fn) {
  const visit = (value, pathParts, parentProp, topLevel, parentTypes) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, [...pathParts, i], parentProp, topLevel, parentTypes));
      return;
    }
    if (!value || typeof value !== 'object' || '@value' in value) return;
    fn(value, { path: pathParts, parentProp, topLevel, parentTypes });
    const own = typesOf(value);
    for (const [k, v] of Object.entries(value)) {
      if (k === '@context' || !v || typeof v !== 'object') continue;
      if (k === '@graph') visit(v, [...pathParts, k], null, true, []);
      else visit(v, [...pathParts, k], k, false, own);
    }
  };
  visit(data, [], null, true, []);
}

/** Values of a dotted property path with their relative JSON paths; arrays expanded, @id references resolved. */
export function values(node, prop, resolve) {
  let current = [{ value: node, path: [] }];
  for (const key of prop.split('.')) {
    const next = [];
    for (const { value, path } of current) {
      let obj = value;
      if (isReference(obj) && resolve) obj = resolve(obj['@id']) || obj;
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      const v = obj[key];
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x, i) => x !== undefined && x !== null && next.push({ value: x, path: [...path, key, i] }));
      else next.push({ value: v, path: [...path, key] });
    }
    current = next;
  }
  return current.map((x) => ({ path: x.path, value: isReference(x.value) && resolve ? resolve(x.value['@id']) || x.value : literal(x.value) }));
}

export function hasProp(node, prop, resolve) {
  return values(node, prop, resolve).some((x) => present(x.value));
}

/** Text of a JSON-LD string as users see it: entities decoded (twice, for &amp;amp;), tags removed, spaces collapsed. */
export function plainText(s) {
  let t = String(s || '');
  for (let i = 0; i < 2 && /&[#a-z0-9]+;/i.test(t); i++) t = decodeEntities(t);
  return t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * FAQPage questions in parsed JSON-LD blocks: [{name, answer, path, block}] and the FAQPage node count. Questions and
 * answers given as @id references (e.g. Yoast's graph) are resolved against every block of the page.
 */
export function faqQuestions(blocks) {
  const questions = [];
  let faqPages = 0;
  const defined = idIndex(blocks).defined;
  const resolve = (v) => (isReference(v) && defined.has(v['@id']) ? defined.get(v['@id'])[0].node : v);
  (blocks || []).forEach((b, block) => {
    if (!b || b.error || !b.data) return;
    walkJsonLd(b.data, (node, ctx) => {
      if (!typesOf(node).includes('FAQPage')) return;
      faqPages++;
      [].concat(node.mainEntity || []).forEach((raw, i) => {
        const q = resolve(raw);
        if (!q || typeof q !== 'object') return;
        const ans = resolve([].concat(q.acceptedAnswer || q.suggestedAnswer || [])[0]);
        questions.push({ name: plainText(literal(q.name)), answer: ans && typeof ans === 'object' ? String(literal(ans.text) || '') : '', path: [...ctx.path, 'mainEntity', ...(Array.isArray(node.mainEntity) ? [i] : [])], block });
      });
    });
  });
  return { questions, faqPages };
}

// ---------- value formats ----------
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/** {ok, dateOnly, timezone, time} for ISO 8601 dates/datetimes. */
export function parseIsoDate(value) {
  const s = String(literal(value) ?? '').trim();
  const d = DATE_RE.exec(s);
  if (d) {
    const t = Date.UTC(+d[1], +d[2] - 1, +d[3]);
    const ok = new Date(t).toISOString().slice(0, 10) === s;
    return { ok, dateOnly: true, timezone: false, time: ok ? t : NaN };
  }
  const m = DATETIME_RE.exec(s);
  if (!m) return { ok: false, dateOnly: false, timezone: false, time: NaN };
  const tz = m[7] ? (/^z$/i.test(m[7]) ? 'Z' : m[7].length === 5 ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : m[7]) : '';
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${tz || 'Z'}`;
  const time = Date.parse(iso);
  const valid = Number.isFinite(time) && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31 && +m[4] < 24 && +m[5] < 60;
  return { ok: valid, dateOnly: false, timezone: Boolean(tz), time: valid ? time : NaN };
}

export function isAbsoluteUrl(value) {
  const s = String(literal(value) ?? '').trim();
  if (!/^https?:\/\//i.test(s) || /\s/.test(s)) return false;
  try {
    return Boolean(new URL(s).hostname);
  } catch {
    return false;
  }
}

/** Price as a plain number or numeric string ("39.99", 0); returns {ok, value, reason}. */
export function parsePrice(value) {
  const v = literal(value);
  if (typeof v === 'number') return Number.isFinite(v) ? { ok: v >= 0, value: v, reason: v < 0 ? 'negative' : '' } : { ok: false, value: NaN, reason: 'not a number' };
  const s = String(v ?? '').trim();
  if (/^\d+(\.\d+)?$/.test(s)) return { ok: true, value: Number(s), reason: '' };
  if (/[^\d.,\s]/.test(s)) return { ok: false, value: NaN, reason: 'contains a currency symbol or text (use a plain number and put the currency in priceCurrency)' };
  if (/,/.test(s)) return { ok: false, value: NaN, reason: 'uses a comma (use "." as the decimal separator and no thousands separator)' };
  return { ok: false, value: NaN, reason: 'not a number' };
}

/** Rating value: number, numeric string, "60%" or "6 / 10" (as allowed by the review snippet docs). */
export function parseRating(value) {
  const v = literal(value);
  if (typeof v === 'number') return Number.isFinite(v) ? { ok: true, value: v } : { ok: false };
  const s = String(v ?? '').trim();
  let m = /^(\d+(?:\.\d+)?)$/.exec(s);
  if (m) return { ok: true, value: Number(m[1]) };
  m = /^(\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (m) return { ok: true, value: Number(m[1]), percent: true };
  m = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (m) return { ok: true, value: Number(m[1]), best: Number(m[2]) };
  return { ok: false };
}

export const isPositiveInteger = (value) => {
  const v = literal(value);
  const s = typeof v === 'number' ? String(v) : String(v ?? '').trim();
  return /^\d+$/.test(s) && Number(s) > 0;
};

export const isIsoDuration = (value) => /^P(?!$)(\d+(\.\d+)?Y)?(\d+(\.\d+)?M)?(\d+(\.\d+)?W)?(\d+(\.\d+)?D)?(T(?=\d)(\d+(\.\d+)?H)?(\d+(\.\d+)?M)?(\d+(\.\d+)?S)?)?$/.test(String(literal(value) ?? '').trim());

export const enumValue = (value) => normType(String(literal(value) ?? '').trim());

/** Placeholder text left in markup (templates, TODOs, sample domains on a site that is not on them). */
export function placeholderIn(text, siteHost = '') {
  const s = String(text || '');
  if (/\{\{[^}]*\}\}|\$\{[^}]*\}|\{[A-Z][A-Z0-9_ ]{2,}\}|\{[^{}]*[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af][^{}]*\}/.test(s)) return 'template placeholder';
  if (/^(https?:\/\/|\/)/i.test(s) && /\{[a-z][a-z0-9_-]{0,40}\}/i.test(s)) return 'template placeholder';
  if (/^\{[^{}]{2,}\}$/.test(s.trim())) return 'template placeholder';
  if (/\b(TODO|TBD|FIXME)\b/.test(s) || /\blorem ipsum\b|\b(your[-_](brand|company|site|domain|logo)|yourbrand|yourcompany|yourdomain)\b|\binsert [a-z]+ here\b/i.test(s)) return 'placeholder text';
  const host = String(siteHost || '').toLowerCase().replace(/^www\./, '');
  const sample = /\bhttps?:\/\/(?:www\.)?(example\.(?:com|org|net))\b/i.exec(s);
  if (sample && host !== sample[1].toLowerCase() && !host.endsWith(`.${sample[1].toLowerCase()}`)) return `sample domain ${sample[1]}`;
  return '';
}

/** Numbers written in visible text, read with "." or "," as decimal separator (prices such as 1,299.00 / 1.299,00). */
export function numbersInText(text) {
  const found = new Set();
  const add = (s) => {
    const n = Number(s);
    if (s !== '' && Number.isFinite(n)) found.add(Math.round(n * 100) / 100);
  };
  const read = (raw) => {
    add(raw.replace(/,/g, ''));
    add(raw.replace(/\./g, '').replace(',', '.'));
  };
  for (const m of String(text || '').matchAll(/\d[\d.,' \u00a0\u202f]*\d|\d/g)) {
    read(m[0].replace(/[' \u00a0\u202f]/g, ''));
    const parts = m[0].split(/[' \u00a0\u202f]+/).filter(Boolean);
    parts.forEach((part, i) => {
      read(part);
      if (i + 1 < parts.length) read(part + parts[i + 1]);
    });
  }
  return found;
}


// ---------- retired and limited types (references/15 §15, verified 2026-11-02) ----------
const BLOG_2025_06 = 'https://developers.google.com/search/blog/2025/06/simplifying-search-results';
const has = (n, k) => present(n && n[k]);
export const STATUS_RULES = [
  { id: 'faq', label: 'FAQ rich result (FAQPage)', status: 'retired', since: '2026-05-07', docUrl: UPDATES_URL, downgrade: true, match: (n, t) => t.includes('FAQPage'), detail: 'Limited to well-known government and health sites since 2023-08; no longer shown for any site since 2026-05-07; documentation removed 2026-06-15, Search Console report and Rich Results Test support dropped in June 2026, Search Console API support ends 2026-08. Keep it only when every question matches the visible FAQ; do not add it for Google.' },
  { id: 'howto', label: 'HowTo', status: 'retired', since: '2023-09-13', docUrl: 'https://developers.google.com/search/blog/2023/08/howto-faq-changes', downgrade: true, match: (n, t) => t.includes('HowTo'), detail: 'No longer shown on desktop or mobile since 2023-09. Mark up only real step-by-step content; no Google rich result.' },
  { id: 'course-info', label: 'Course Info', status: 'retired', since: '2025-09-09', docUrl: BLOG_2025_06, match: (n, t) => t.includes('Course') && ['hasCourseInstance', 'offers', 'educationalLevel', 'totalHistoricalEnrollment', 'aggregateRating', 'financialAidEligible', 'syllabusSections', 'coursePrerequisites'].some((k) => has(n, k)), detail: 'Course Info is no longer shown (announced 2025-06-12, removed from Search Console and the Rich Results Test 2025-09-09). The Course list carousel (ItemList of 3+ Course with name, description, provider) is still documented.' },
  { id: 'claim-review', label: 'ClaimReview (fact check)', status: 'retired', since: '2025-09-09', docUrl: BLOG_2025_06, downgrade: true, match: (n, t) => t.includes('ClaimReview'), detail: 'Phased out of Search results (announced 2025-06-12; Search Console and Rich Results Test support removed 2025-09-09).' },
  { id: 'estimated-salary', label: 'Estimated Salary', status: 'retired', since: '2025-09-09', docUrl: BLOG_2025_06, downgrade: true, match: (n, t) => t.includes('Occupation') || t.includes('OccupationAggregationByEmployer'), detail: 'Phased out of Search results (announced 2025-06-12; documentation removed 2025-09-09).' },
  { id: 'learning-video', label: 'Learning Video', status: 'retired', since: '2025-09-09', docUrl: BLOG_2025_06, match: (n, t) => t.includes('LearningResource') || (t.includes('VideoObject') && ['educationalLevel', 'learningResourceType', 'educationalAlignment', 'teaches'].some((k) => has(n, k))), detail: 'The Learning Video enhancement is no longer shown (documentation removed 2025-09-09); ordinary video results still use VideoObject.' },
  { id: 'special-announcement', label: 'Special Announcement', status: 'retired', since: '2025-07-31', docUrl: UPDATES_URL, downgrade: true, match: (n, t) => t.includes('SpecialAnnouncement'), detail: 'Deprecated 2025-07-31; documentation removed 2025-09-09.' },
  { id: 'vehicle-listing', label: 'Vehicle Listing', status: 'retired', since: '2025-09-09', docUrl: BLOG_2025_06, match: (n, t) => t.some((x) => VEHICLE_TYPES.has(x)) && has(n, 'offers'), detail: 'Vehicle listing rich results were phased out (deprecation announced 2025-06-12; unsupported since 2025-09-09).' },
  { id: 'practice-problem', label: 'Practice problem (Quiz)', status: 'retired', since: '2026-01-06', docUrl: UPDATES_URL, downgrade: true, match: (n, t) => t.includes('Quiz'), detail: 'Deprecation announced 2025-11-05; documentation removed 2026-01-06; no longer shown.' },
  { id: 'dataset', label: 'Dataset', status: 'limited', since: '2025-11-05', docUrl: `${SD}dataset`, downgrade: true, match: (n, t) => t.includes('Dataset'), detail: 'Used only by Dataset Search, not by Google Search results (clarified 2025-11-05).' },
  { id: 'book-actions', label: 'Book Actions', status: 'supported (limited)', since: '2025-11-05', docUrl: `${SD}book`, downgrade: true, match: (n, t) => t.includes('Book') && /ReadAction|BorrowAction/.test(JSON.stringify(n.workExample || n.potentialAction || '')), detail: 'The 2025-06 deprecation was retracted on 2025-11-05 (a Search feature still uses it); it works through a data feed for onboarded book providers only.' },
  { id: 'sitelinks-search-box', label: 'Sitelinks search box (WebSite SearchAction)', status: 'retired', since: '2024-11-21', docUrl: 'https://developers.google.com/search/blog/2024/10/sitelinks-search-box', match: (n, t) => t.includes('WebSite') && /SearchAction/.test(JSON.stringify(n.potentialAction || '')), detail: 'Not shown since 2024-11-21. The WebSite name/url markup for site names is still supported; removing the SearchAction is optional.' },
  { id: 'breadcrumb-mobile', label: 'BreadcrumbList', status: 'limited', since: '2025-01-23', docUrl: 'https://developers.google.com/search/blog/2025/01/simplifying-breadcrumbs', match: (n, t) => t.includes('BreadcrumbList'), detail: 'Not shown on mobile results since 2025-01-23; still shown on desktop and still recommended.' },
];

/** A Product that only points to a variant page (url / isVariantOf, no name or offers): the full markup lives there. */
export function isLinkOnlyProduct(node) {
  return typesOf(node).some((t) => PRODUCT_TYPES.has(t)) && !present(node.name) && !present(node.offers) && !present(node.review) && !present(node.aggregateRating) && (present(node.url) || present(node.isVariantOf) || present(node['@id']));
}

/** Status rules (retired/limited types) that match a node. */
export function statusFor(node) {
  const t = typesOf(node);
  return t.length ? STATUS_RULES.filter((s) => s.match(node, t)) : [];
}

// ---------- checker ----------
class Checker {
  constructor({ node, nodePath, rule, resolve, page, issues, topLevel, parentProp, downgrade, incoming }) {
    Object.assign(this, { node, nodePath, rule, resolve, page, issues, topLevel, parentProp, downgrade, incoming: incoming || new Set() });
    this.typeLabel = typesOf(node).join(',') || rule.id;
  }

  issue(severity, ruleId, relPath, detail, source) {
    let sev = severity;
    let text = detail;
    if (this.downgrade && sev === 'error') {
      sev = 'warning';
      text = `${detail} (retired or limited type: reported as a warning)`;
    }
    this.issues.push({ severity: sev, rule: ruleId, type: this.typeLabel, path: jsonPath([...this.nodePath, ...relPath]), detail: text, source: source || this.rule.docUrl });
  }

  vals(prop) {
    return values(this.node, prop, this.resolve);
  }

  has(prop) {
    return hasProp(this.node, prop, this.resolve);
  }

  required(prop, detail) {
    if (!this.has(prop)) this.issue('error', 'required-missing', prop.split('.'), detail || `Missing required property "${prop}"`);
  }

  recommended(prop, severity = 'warning', detail) {
    if (!this.has(prop)) this.issue(severity, 'recommended-missing', prop.split('.'), detail || `Missing recommended property "${prop}"`);
  }

  oneOf(props, detail, severity = 'error') {
    if (!props.some((p) => this.has(p))) this.issue(severity, 'required-one-of', [], detail || `Needs at least one of: ${props.join(', ')}`);
  }
}

// ---------- shared sub-checks ----------
function checkOffer(c, offer, rel, { merchant = false, label = 'offers' } = {}) {
  const t = typesOf(offer);
  const sub = values(offer, 'price', c.resolve).concat(values(offer, 'priceSpecification.price', c.resolve));
  if (t.includes('AggregateOffer')) {
    const low = values(offer, 'lowPrice', c.resolve);
    if (!low.length) c.issue('error', 'required-missing', [...rel, 'lowPrice'], `AggregateOffer needs "lowPrice"`);
    for (const { value, path } of [...low, ...values(offer, 'highPrice', c.resolve)]) {
      const p = parsePrice(value);
      if (!p.ok) c.issue('error', 'invalid-price', [...rel, ...path], `${path[0]} "${value}" ${p.reason}`);
    }
    if (!hasProp(offer, 'priceCurrency', c.resolve)) c.issue('error', 'required-missing', [...rel, 'priceCurrency'], 'AggregateOffer needs "priceCurrency"');
  } else {
    if (!sub.length) c.issue('error', 'required-missing', [...rel, 'price'], `Missing required property "${label}.price" (use 0 for free)`);
    for (const { value, path } of sub) {
      const p = parsePrice(value);
      if (!p.ok) c.issue('error', 'invalid-price', [...rel, ...path], `price "${value}" ${p.reason}`);
      else if (merchant && p.value <= 0) c.issue('warning', 'merchant-price-zero', [...rel, ...path], 'Merchant listings need a price greater than zero (product snippets accept 0)', `${SD}merchant-listing`);
    }
    if (!hasProp(offer, 'priceCurrency', c.resolve) && !hasProp(offer, 'priceSpecification.priceCurrency', c.resolve)) {
      if (merchant) c.issue('warning', 'merchant-currency-missing', [...rel, 'priceCurrency'], 'priceCurrency is required for merchant listings (recommended for product snippets)', `${SD}merchant-listing`);
      else c.issue('warning', 'recommended-missing', [...rel, 'priceCurrency'], 'Missing recommended property "priceCurrency"');
    }
  }
  for (const { value, path } of values(offer, 'priceCurrency', c.resolve).concat(values(offer, 'priceSpecification.priceCurrency', c.resolve))) {
    const s = String(value ?? '').trim();
    if (!/^[A-Za-z]{3}$/.test(s)) c.issue('error', 'invalid-currency', [...rel, ...path], `priceCurrency "${s}" is not a three-letter ISO 4217 code (e.g. USD, EUR, TWD)`);
    else if (s !== s.toUpperCase()) c.issue('warning', 'invalid-currency', [...rel, ...path], `priceCurrency "${s}" should be upper case (${s.toUpperCase()})`);
    else if (!ISO_4217.has(s)) c.issue('warning', 'invalid-currency', [...rel, ...path], `priceCurrency "${s}" is not a known ISO 4217 code`);
  }
  for (const { value, path } of values(offer, 'availability', c.resolve)) {
    const e = enumValue(value);
    if (!SCHEMA_AVAILABILITY.has(e)) c.issue('warning', 'invalid-availability', [...rel, ...path], `availability "${value}" is not a schema.org ItemAvailability value (InStock, OutOfStock, PreOrder, BackOrder, ...)`);
    else if (!GOOGLE_AVAILABILITY.has(e)) c.issue('info', 'invalid-availability', [...rel, ...path], `availability "${e}" is valid schema.org but not in Google's supported list`);
  }
  for (const { value, path } of values(offer, 'itemCondition', c.resolve)) {
    if (!ITEM_CONDITIONS.has(enumValue(value))) c.issue('warning', 'invalid-enum', [...rel, ...path], `itemCondition "${value}" is not NewCondition, UsedCondition, RefurbishedCondition or DamagedCondition`);
  }
  for (const { value, path } of values(offer, 'priceValidUntil', c.resolve)) {
    const d = parseIsoDate(value);
    if (d.ok && c.page && c.page.now && d.time < c.page.now - 86400000) c.issue('warning', 'date-in-past', [...rel, ...path], `priceValidUntil ${value} is in the past; the snippet may not show`);
  }
}

function checkRatingValue(c, rating, rel, label) {
  const rv = values(rating, 'ratingValue', c.resolve);
  if (!rv.length) {
    c.issue('error', 'required-missing', [...rel, 'ratingValue'], `${label} needs "ratingValue"`);
    return null;
  }
  const r = parseRating(rv[0].value);
  if (!r.ok) {
    c.issue('error', 'invalid-rating', [...rel, ...rv[0].path], `ratingValue "${rv[0].value}" is not a number, fraction or percentage`);
    return null;
  }
  if (r.percent) {
    if (r.value <= 100) return r;
    c.issue('error', 'rating-out-of-range', [...rel, ...rv[0].path], `ratingValue ${rv[0].value} is outside 0-100%`);
    return null;
  }
  const best = r.best ?? numberOr(values(rating, 'bestRating', c.resolve), 5);
  const worst = numberOr(values(rating, 'worstRating', c.resolve), 1);
  if (r.value > best || r.value < worst) c.issue('error', 'rating-out-of-range', [...rel, ...rv[0].path], `ratingValue ${r.value} is outside worstRating..bestRating (${worst}..${best}; defaults 1..5)`);
  return r;
}

function numberOr(list, fallback) {
  const n = list.length ? Number(literal(list[0].value)) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function checkAggregateRating(c, rating, rel, { nested = true } = {}) {
  const r = checkRatingValue(c, rating, rel, 'AggregateRating');
  const counts = values(rating, 'ratingCount', c.resolve).concat(values(rating, 'reviewCount', c.resolve));
  if (!counts.length) c.issue('error', 'required-one-of', rel, 'AggregateRating needs ratingCount or reviewCount');
  for (const { value, path } of counts) if (!isPositiveInteger(value)) c.issue('error', 'invalid-count', [...rel, ...path], `${path[path.length - 1]} "${value}" must be a positive whole number`);
  if (!nested) {
    if (!hasProp(rating, 'itemReviewed', c.resolve)) c.issue('error', 'required-missing', [...rel, 'itemReviewed'], 'A top-level AggregateRating needs "itemReviewed"');
    else if (!hasProp(rating, 'itemReviewed.name', c.resolve)) c.issue('error', 'required-missing', [...rel, 'itemReviewed', 'name'], 'itemReviewed needs a "name"');
  }
  if (r && c.page && c.page.numbers && !c.page.numbers.has(Math.round(r.value * 100) / 100)) c.issue('warning', 'rating-not-visible', [...rel, 'ratingValue'], `ratingValue ${r.value} does not appear in the visible text (markup must match what users see)`, POLICY_URL);
}

function checkReview(c, review, rel, { nested }) {
  if (!hasProp(review, 'author', c.resolve)) c.issue('error', 'required-missing', [...rel, 'author'], 'Review needs an "author" (Person or Organization with a real name)');
  for (const { value, path } of values(review, 'author', c.resolve)) {
    const name = value && typeof value === 'object' ? literal(value.name) : value;
    if (!present(name) && !(value && value['@id'])) c.issue('error', 'required-missing', [...rel, ...path, 'name'], 'Review author needs a "name"');
    else if (String(name || '').length >= 100) c.issue('warning', 'invalid-value', [...rel, ...path, 'name'], 'Review author name must be under 100 characters');
  }
  const rr = values(review, 'reviewRating', c.resolve);
  if (!rr.length) c.issue('error', 'required-missing', [...rel, 'reviewRating'], 'Review needs "reviewRating" with a ratingValue');
  else checkRatingValue(c, rr[0].value, [...rel, ...rr[0].path], 'reviewRating');
  if (!nested) {
    if (!hasProp(review, 'itemReviewed', c.resolve)) c.issue('error', 'required-missing', [...rel, 'itemReviewed'], 'A top-level Review needs "itemReviewed"');
    else if (!hasProp(review, 'itemReviewed.name', c.resolve)) c.issue('error', 'required-missing', [...rel, 'itemReviewed', 'name'], 'itemReviewed needs a "name"');
  }
  if (!hasProp(review, 'datePublished', c.resolve)) c.issue('info', 'recommended-missing', [...rel, 'datePublished'], 'Missing recommended property "datePublished"');
}

function selfServing(c) {
  if (c.has('aggregateRating') || c.has('review')) c.issue('info', 'self-serving-review', [c.has('aggregateRating') ? 'aggregateRating' : 'review'], 'Reviews of an Organization/LocalBusiness on its own site are not eligible for review stars (only sites that collect reviews about other businesses)', `${SD}review-snippet`);
}

function checkAddress(c) {
  for (const { value, path } of c.vals('address')) {
    if (typeof value === 'string') c.issue('warning', 'invalid-value', path, 'address should be a PostalAddress object (streetAddress, addressLocality, postalCode, addressCountry), not a string');
    else if (value && typeof value === 'object') {
      const country = literal(value.addressCountry);
      if (typeof country === 'string' && country && !/^[A-Z]{2}$/.test(country.trim())) c.issue('info', 'invalid-value', [...path, 'addressCountry'], `addressCountry "${country}" should be a two-letter ISO 3166-1 code`);
    }
  }
}

function checkTelephone(c) {
  for (const { value, path } of c.vals('telephone')) if (typeof value === 'string' && value.trim() && !value.trim().startsWith('+')) c.issue('info', 'invalid-value', path, `telephone "${value}" should include the country code (e.g. +1-555-...)`);
}

// ---------- type rules ----------
export const RULES = [
  {
    id: 'LocalBusiness', match: (t) => t.some((x) => LOCAL_BUSINESS_TYPES.has(x)), docUrl: `${SD}local-business`, docUpdated: '2026-09-08',
    required: ['name', 'address'], recommended: ['telephone', 'url', 'geo', 'openingHoursSpecification'],
    check(c) {
      c.required('name');
      c.required('address', 'Missing required property "address" (PostalAddress of the physical location)');
      for (const p of ['telephone', 'url', 'geo', 'openingHoursSpecification']) c.recommended(p);
      checkAddress(c);
      checkTelephone(c);
      for (const axis of ['latitude', 'longitude']) {
        for (const { value, path } of c.vals(`geo.${axis}`)) {
          const n = Number(literal(value));
          const limit = axis === 'latitude' ? 90 : 180;
          if (!Number.isFinite(n) || Math.abs(n) > limit) c.issue('warning', 'invalid-value', path, `geo.${axis} "${value}" is not a valid coordinate`);
          else if (((String(literal(value)).split('.')[1] || '').length) < 5) c.issue('info', 'geo-precision', path, `geo.${axis} should have at least 5 decimal places`);
        }
      }
      for (const { value, path } of c.vals('openingHoursSpecification')) {
        if (!value || typeof value !== 'object') continue;
        for (const k of ['opens', 'closes']) {
          const v = literal(value[k]);
          if (v !== undefined && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(v))) c.issue('warning', 'invalid-value', [...path, k], `${k} "${v}" must be hh:mm or hh:mm:ss`);
        }
        for (const d of [].concat(value.dayOfWeek || [])) if (!DAYS.has(enumValue(d))) c.issue('warning', 'invalid-enum', [...path, 'dayOfWeek'], `dayOfWeek "${d}" is not a schema.org DayOfWeek`);
      }
      for (const { value, path } of c.vals('priceRange')) if (String(value).length >= 100) c.issue('warning', 'invalid-value', path, 'priceRange must be shorter than 100 characters or Google ignores it');
      selfServing(c);
    },
  },
  {
    id: 'Organization', match: (t) => t.some((x) => ORGANIZATION_TYPES.has(x)) && !t.some((x) => LOCAL_BUSINESS_TYPES.has(x)), docUrl: ORGANIZATION_DOC, docUpdated: '2026-09-08',
    required: [], recommended: ['name', 'url', 'logo'],
    check(c) {
      c.recommended('name');
      c.recommended('url', 'warning', 'Missing recommended property "url" (helps Google identify the organization)');
      c.recommended('logo', 'info', 'Add a logo (at least 112x112 px, crawlable and indexable)');
      checkAddress(c);
      checkTelephone(c);
      selfServing(c);
    },
  },
  {
    id: 'WebSite', match: (t) => t.includes('WebSite'), docUrl: 'https://developers.google.com/search/docs/appearance/site-names', docUpdated: '2025-12-10',
    required: ['name', 'url'], recommended: ['alternateName'],
    check(c) {
      c.required('name', 'Missing required property "name" (site name shown in results)');
      c.required('url', 'Missing required property "url" (the home page of the domain or subdomain)');
      for (const { value, path } of c.vals('url')) {
        if (!isAbsoluteUrl(value)) continue;
        const u = new URL(String(value));
        if (u.pathname !== '/' || u.search) c.issue('warning', 'website-url-not-home', path, `WebSite url ${value} is not a home page: site names work only at the domain or subdomain root`);
      }
    },
  },
  {
    id: 'Article', match: (t) => t.some((x) => ARTICLE_TYPES.has(x)), docUrl: `${SD}article`, docUpdated: '2026-09-08',
    required: [], recommended: ['headline', 'image', 'datePublished', 'dateModified', 'author'],
    check(c) {
      for (const p of ['headline', 'image', 'datePublished', 'dateModified', 'author']) c.recommended(p);
      for (const { value, path } of c.vals('author')) {
        if (!value || typeof value !== 'object') {
          if (typeof value === 'string') c.issue('warning', 'invalid-value', path, 'author should be a Person or Organization object with name (and url), not a plain string');
          continue;
        }
        const t = typesOf(value);
        if (t.length && !t.some((x) => x === 'Person' || ORGANIZATION_TYPES.has(x))) c.issue('warning', 'invalid-value', path, `author type ${t.join(',')} should be Person or Organization`);
        if (!present(literal(value.name)) && !value['@id']) c.issue('warning', 'recommended-missing', [...path, 'name'], 'author.name is missing');
        else if (present(value.name) && /^(posted by|by|written by)\b/i.test(String(literal(value.name)))) c.issue('info', 'invalid-value', [...path, 'name'], 'author.name should contain only the name (no "by", "posted by", job titles)');
      }
      for (const p of ['datePublished', 'dateModified']) {
        for (const { value, path } of c.vals(p)) {
          const d = parseIsoDate(value);
          if (d.ok && (d.dateOnly || !d.timezone)) c.issue('info', 'date-no-timezone', path, `${p} "${value}" has no ${d.dateOnly ? 'time and ' : ''}time zone; Google recommends one (otherwise Googlebot's time zone is assumed)`);
        }
      }
      const pub = c.vals('datePublished')[0];
      const mod = c.vals('dateModified')[0];
      if (pub && mod) {
        const a = parseIsoDate(pub.value);
        const b = parseIsoDate(mod.value);
        if (a.ok && b.ok && b.time < a.time - 86400000) c.issue('warning', 'date-order', mod.path, `dateModified ${mod.value} is before datePublished ${pub.value}`);
      }
    },
  },
  {
    id: 'Product', match: (t) => t.some((x) => PRODUCT_TYPES.has(x)), docUrl: `${SD}product-snippet`, docUpdated: '2026-09-08',
    required: ['name'], oneOf: [['offers', 'review', 'aggregateRating']], recommended: [],
    check(c) {
      if (isLinkOnlyProduct(c.node)) return;
      c.required('name');
      c.oneOf(['offers', 'review', 'aggregateRating'], 'Product snippets need at least one of: offers, review, aggregateRating');
      const offers = c.vals('offers');
      const merchant = offers.some((o) => o.value && typeof o.value === 'object' && !typesOf(o.value).includes('AggregateOffer'));
      for (const { value, path } of offers) if (value && typeof value === 'object') checkOffer(c, value, path, { merchant });
      if (merchant && !c.has('image')) c.issue('warning', 'merchant-image-missing', ['image'], 'image is required for merchant listings (Shopping) when the page sells the product', `${SD}merchant-listing`);
      for (const { value, path } of c.vals('aggregateRating')) if (value && typeof value === 'object') checkAggregateRating(c, value, path);
      if (c.page && c.page.numbers) {
        const prices = offers.flatMap((o) => (o.value && typeof o.value === 'object' ? values(o.value, 'price', c.resolve).concat(values(o.value, 'lowPrice', c.resolve)).map((x) => ({ ...x, path: [...o.path, ...x.path] })) : []));
        for (const { value, path } of prices) {
          const p = parsePrice(value);
          if (p.ok && p.value > 0 && !c.page.numbers.has(Math.round(p.value * 100) / 100)) c.issue('warning', 'price-not-visible', path, `Price ${value} does not appear in the visible text (markup must match what users see)`, POLICY_URL);
        }
      }
    },
  },
  {
    id: 'ProductGroup', match: (t) => t.includes('ProductGroup'), docUrl: `${SD}product-variants`, docUpdated: '2026-09-08',
    required: ['name'], recommended: ['productGroupID', 'variesBy', 'hasVariant'],
    check(c) {
      c.required('name');
      if (!c.has('productGroupID')) c.issue('warning', 'recommended-missing', ['productGroupID'], 'Missing "productGroupID" (or inProductGroupWithID on every variant)');
      c.recommended('variesBy');
      if (!c.has('hasVariant')) c.issue('info', 'recommended-missing', ['hasVariant'], 'No hasVariant: variants must point back with isVariantOf');
    },
  },
  {
    id: 'Review', match: (t) => t.some((x) => REVIEW_TYPES.has(x)), docUrl: `${SD}review-snippet`, docUpdated: '2026-09-08',
    required: ['author', 'reviewRating.ratingValue', 'itemReviewed.name (top-level only)'], recommended: ['datePublished'],
    check(c) {
      checkReview(c, c.node, [], { nested: (!c.topLevel && c.parentProp === 'review') || c.incoming.has('review') });
    },
  },
  {
    id: 'AggregateRating', match: (t) => t.includes('AggregateRating'), topLevelOnly: true, docUrl: `${SD}review-snippet`, docUpdated: '2026-09-08',
    required: ['ratingValue', 'ratingCount|reviewCount', 'itemReviewed.name'], recommended: ['bestRating', 'worstRating'],
    check(c) {
      if (c.incoming.has('aggregateRating')) return;
      checkAggregateRating(c, c.node, [], { nested: false });
    },
  },
  {
    id: 'BreadcrumbList', match: (t) => t.includes('BreadcrumbList'), docUrl: `${SD}breadcrumb`, docUpdated: '2026-09-08',
    required: ['itemListElement (ListItem: position, name, item except the last)'], recommended: [],
    check(c) {
      const items = c.vals('itemListElement');
      if (!items.length) {
        c.issue('error', 'required-missing', ['itemListElement'], 'BreadcrumbList needs itemListElement (ListItem entries)');
        return;
      }
      if (items.length < 2) c.issue('warning', 'breadcrumb-too-short', ['itemListElement'], 'A BreadcrumbList needs at least two ListItems');
      const positions = [];
      items.forEach(({ value, path }, i) => {
        if (!value || typeof value !== 'object') return;
        const last = i === items.length - 1;
        const pos = literal(value.position);
        if (pos === undefined) c.issue('error', 'required-missing', [...path, 'position'], 'ListItem needs "position" (1, 2, 3, ...)');
        else if (!/^\d+$/.test(String(pos)) || Number(pos) < 1) c.issue('error', 'invalid-value', [...path, 'position'], `position "${pos}" must be an integer starting at 1`);
        else positions.push(Number(pos));
        const item = value.item;
        const itemObj = item && typeof item === 'object' ? item : null;
        const name = literal(value.name) ?? (itemObj ? literal(itemObj.name) : undefined);
        if (!present(name)) c.issue('error', 'required-missing', [...path, 'name'], 'ListItem needs "name" (or an item object with a name)');
        else if (c.page && c.page.visibleKey && !c.page.visibleKey.includes(compactKey(name))) c.issue('info', 'breadcrumb-not-visible', [...path, 'name'], `Breadcrumb name "${name}" does not appear in the visible text`, POLICY_URL);
        const itemUrl = itemObj ? literal(itemObj['@id'] || itemObj.url) : literal(item);
        if (!present(itemUrl)) {
          if (!last) c.issue('error', 'required-missing', [...path, 'item'], 'ListItem needs "item" (URL) except for the last breadcrumb');
        } else if (!isAbsoluteUrl(itemUrl)) c.issue('warning', 'invalid-url', [...path, 'item'], `item "${itemUrl}" should be an absolute URL`);
      });
      const sorted = positions.slice().sort((a, b) => a - b);
      if (sorted.length && sorted.some((p, i) => p !== i + 1)) c.issue('warning', 'invalid-value', ['itemListElement'], `ListItem positions should run 1..${sorted.length} without gaps (got ${positions.join(',')})`);
    },
  },
  {
    id: 'FAQPage', match: (t) => t.includes('FAQPage'), docUrl: UPDATES_URL, docUpdated: '2026-06-15 (documentation removed)',
    required: ['mainEntity (Question: name, acceptedAnswer.text)'], recommended: [],
    check(c) {
      const qs = c.vals('mainEntity');
      if (!qs.length) c.issue('error', 'required-missing', ['mainEntity'], 'FAQPage needs mainEntity with Question items');
      for (const { value, path } of qs) {
        if (!value || typeof value !== 'object') continue;
        const name = plainText(literal(value.name));
        if (!name) c.issue('error', 'required-missing', [...path, 'name'], 'Question needs "name" (the question text)');
        const ans = values(value, 'acceptedAnswer', c.resolve)[0];
        const text = ans && ans.value && typeof ans.value === 'object' ? String(literal(ans.value.text) || '') : '';
        if (!ans) c.issue('error', 'required-missing', [...path, 'acceptedAnswer'], 'Question needs "acceptedAnswer"');
        else if (!text.trim()) c.issue('error', 'required-missing', [...path, ...ans.path, 'text'], 'acceptedAnswer needs "text"');
        if (!c.page || !c.page.visibleKey) continue;
        if (name && !c.page.visibleKey.includes(compactKey(name))) {
          c.issues.push({ severity: 'error', rule: 'faq-not-visible', type: c.typeLabel, path: jsonPath([...c.nodePath, ...path, 'name']), detail: `FAQ question not in the visible text: "${name.slice(0, 120)}" (every question must appear verbatim on the page)`, source: POLICY_URL });
        } else if (text.trim() && answerAbsent(text, c.page)) {
          c.issues.push({ severity: 'warning', rule: 'faq-answer-not-visible', type: c.typeLabel, path: jsonPath([...c.nodePath, ...path, ...ans.path, 'text']), detail: `FAQ answer is not on the page: "${plainText(text).slice(0, 100)}"`, source: POLICY_URL });
        }
      }
    },
  },
  {
    id: 'VideoObject', match: (t) => t.includes('VideoObject'), docUrl: `${SD}video`, docUpdated: '2026-09-24',
    required: ['name', 'thumbnailUrl', 'uploadDate'], recommended: ['description', 'duration', 'contentUrl|embedUrl'],
    check(c) {
      for (const p of ['name', 'thumbnailUrl', 'uploadDate']) c.required(p);
      c.recommended('description');
      c.recommended('duration');
      if (!c.has('contentUrl') && !c.has('embedUrl')) c.issue('warning', 'recommended-missing', ['contentUrl'], 'Add contentUrl (the video file) or embedUrl (the player) so Google can fetch the video');
      for (const { value, path } of c.vals('uploadDate')) {
        const d = parseIsoDate(value);
        if (d.ok && !d.timezone) c.issue('info', 'date-no-timezone', path, `uploadDate "${value}" has no time zone; Google recommends one`);
      }
      for (const { value, path } of c.vals('duration')) if (!isIsoDuration(value)) c.issue('warning', 'invalid-duration', path, `duration "${value}" is not an ISO 8601 duration (e.g. PT1M33S)`);
      for (const { value, path } of c.vals('contentUrl')) if (c.page && c.page.url && String(value).replace(/[#?].*$/, '') === c.page.url.replace(/[#?].*$/, '')) c.issue('warning', 'invalid-url', path, 'contentUrl must point to the video file, not to the page that shows it');
    },
  },
  {
    id: 'Event', match: (t) => t.some((x) => x === 'Event' || x === 'Festival' || x === 'Hackathon' || (/Event$/.test(x) && !['BroadcastEvent', 'PublicationEvent', 'OnDemandEvent', 'DeliveryEvent'].includes(x))), docUrl: `${SD}event`, docUpdated: '2026-09-08',
    required: ['name', 'startDate', 'location (Place with address)'], recommended: ['description', 'endDate', 'eventStatus', 'image', 'offers', 'organizer', 'performer'],
    check(c) {
      c.required('name');
      c.required('startDate');
      const locs = c.vals('location');
      if (!locs.length) c.issue('error', 'required-missing', ['location'], 'Event needs "location": a Place with name and a PostalAddress');
      else {
        const places = locs.filter((l) => l.value && typeof l.value === 'object' && !typesOf(l.value).includes('VirtualLocation'));
        if (!places.length) c.issue('error', 'event-not-physical', locs[0].path, 'Online-only events are not eligible since 2025-06: "Events must take place in a physical location" (add the venue as a Place with address)');
        for (const { value, path } of places) {
          if (typesOf(value).includes('PostalAddress')) c.issue('error', 'invalid-value', path, 'location must be a Place (with name and address), not a PostalAddress');
          else if (!present(value.address)) c.issue('error', 'required-missing', [...path, 'address'], 'location.address (PostalAddress of the venue) is required');
          else if (!present(value.name)) c.issue('warning', 'recommended-missing', [...path, 'name'], 'location.name (venue name) is recommended');
        }
      }
      for (const p of ['description', 'endDate', 'eventStatus', 'image', 'offers', 'organizer', 'performer']) c.recommended(p);
      for (const { value, path } of c.vals('eventStatus')) {
        const e = enumValue(value);
        if (!EVENT_STATUS.has(e)) c.issue('warning', 'invalid-enum', path, `eventStatus "${value}" is not EventScheduled, EventCancelled, EventPostponed or EventRescheduled`);
        else if (e === 'EventMovedOnline') c.issue('warning', 'event-not-physical', path, 'EventMovedOnline: online events are no longer eligible (2025-06)');
      }
      for (const { value, path } of c.vals('eventAttendanceMode')) {
        const e = enumValue(value);
        if (!ATTENDANCE_MODES.has(e)) c.issue('warning', 'invalid-enum', path, `eventAttendanceMode "${value}" is not a schema.org EventAttendanceModeEnumeration value`);
        else if (e === 'OnlineEventAttendanceMode') c.issue('warning', 'event-not-physical', path, 'Online-only attendance: not eligible for the event experience since 2025-06');
      }
      if (c.has('previousStartDate') && !c.vals('eventStatus').some((v) => enumValue(v.value) === 'EventRescheduled')) c.issue('warning', 'invalid-value', ['previousStartDate'], 'previousStartDate needs eventStatus EventRescheduled');
      const start = c.vals('startDate')[0];
      const end = c.vals('endDate')[0];
      if (start && end) {
        const a = parseIsoDate(start.value);
        const b = parseIsoDate(end.value);
        if (a.ok && b.ok && b.time < a.time) c.issue('warning', 'date-order', end.path, `endDate ${end.value} is before startDate ${start.value}`);
      }
      for (const { value, path } of c.vals('offers')) if (value && typeof value === 'object') checkOffer(c, value, path, { merchant: false });
    },
  },
  {
    id: 'SoftwareApplication', match: (t) => t.some((x) => SOFTWARE_TYPES.has(x)), docUrl: `${SD}software-app`, docUpdated: '2026-09-08',
    required: ['name', 'offers.price'], oneOf: [['aggregateRating', 'review']], recommended: ['applicationCategory', 'operatingSystem'],
    check(c) {
      c.required('name');
      const rated = c.has('aggregateRating') || c.has('review');
      if (!rated) c.issue('warning', 'not-eligible', [], 'Not eligible for the software app rich result: it needs aggregateRating or review from genuine users. Fine when the markup only describes the app (do not add self-collected ratings for stars)');
      if (!c.has('offers')) c.issue(rated ? 'error' : 'warning', 'required-missing', ['offers', 'price'], 'Missing property "offers.price" (set it to 0 when the app is free)');
      for (const { value, path } of c.vals('offers')) if (value && typeof value === 'object') checkOffer(c, value, path, { merchant: false });
      for (const { value, path } of c.vals('aggregateRating')) if (value && typeof value === 'object') checkAggregateRating(c, value, path);
      c.recommended('applicationCategory');
      c.recommended('operatingSystem');
      for (const { value, path } of c.vals('applicationCategory')) if (!APP_CATEGORIES.has(enumValue(value))) c.issue('info', 'invalid-enum', path, `applicationCategory "${value}" is not one of Google's supported app types (GameApplication, BusinessApplication, UtilitiesApplication, ...)`);
      const t = typesOf(c.node);
      if (t.length === 1 && t[0] === 'VideoGame') c.issue('warning', 'invalid-value', ['@type'], 'VideoGame alone is not eligible: combine it with another type, e.g. ["VideoGame", "MobileApplication"]');
    },
  },
  {
    id: 'Course', match: (t) => t.includes('Course'), docUrl: `${SD}course`, docUpdated: '2026-09-08',
    required: ['name', 'description'], recommended: ['provider'],
    check(c) {
      c.required('name');
      c.required('description');
      c.recommended('provider', 'warning', 'Each course needs a provider (the organization that publishes it)');
    },
  },
  {
    id: 'Dataset', match: (t) => t.includes('Dataset'), docUrl: `${SD}dataset`, docUpdated: '2026-09-08',
    required: ['name', 'description'], recommended: [],
    check(c) {
      c.required('name');
      c.required('description');
      for (const { value, path } of c.vals('description')) {
        const n = String(value).length;
        if (n < 50 || n > 5000) c.issue('warning', 'invalid-value', path, `description is ${n} characters; Dataset Search expects 50-5000`);
      }
    },
  },
  {
    id: 'DefinedTerm', match: (t) => t.includes('DefinedTerm'), docUrl: 'https://schema.org/DefinedTerm', docUpdated: 'schema.org (not a Google rich result)',
    required: ['name'], recommended: ['description'],
    check(c) {
      c.required('name', 'DefinedTerm needs "name" (schema.org sanity check; not a Google rich result type)');
      c.recommended('description');
      if (!c.has('inDefinedTermSet')) c.issue('info', 'recommended-missing', ['inDefinedTermSet'], 'Add inDefinedTermSet (and termCode) so the term belongs to a glossary');
    },
  },
  {
    id: 'ProfilePage', match: (t) => t.includes('ProfilePage'), docUrl: `${SD}profile-page`, docUpdated: '2026-09-08',
    required: ['mainEntity (Person or Organization with name)'], recommended: ['dateCreated', 'dateModified'],
    check(c) {
      if (!c.has('mainEntity')) c.issue('error', 'required-missing', ['mainEntity'], 'ProfilePage needs mainEntity (the Person or Organization the page is about)');
      else if (!c.has('mainEntity.name') && !c.has('mainEntity.alternateName')) c.issue('error', 'required-missing', ['mainEntity', 'name'], 'ProfilePage mainEntity needs "name" (or alternateName)');
    },
  },
  {
    id: 'Person', match: (t) => t.includes('Person'), docUrl: 'https://schema.org/Person', docUpdated: 'schema.org',
    required: ['name'], recommended: ['url'],
    check(c) {
      c.required('name', 'Person needs "name"');
      c.recommended('url', 'info', 'Add url (an about/bio page) so the person can be identified');
    },
  },
  {
    id: 'ImageObject', match: (t) => t.includes('ImageObject'), topLevelOnly: true, docUrl: `${SD}image-license-metadata`, docUpdated: '2025-12-10',
    required: ['contentUrl (or url)', 'one of creator, creditText, copyrightNotice, license (license metadata only)'], recommended: ['acquireLicensePage', 'license'],
    check(c) {
      if (!c.has('contentUrl') && !c.has('url')) c.issue('error', 'required-missing', ['contentUrl'], 'ImageObject needs contentUrl (the image file) or url');
      if (['license', 'acquireLicensePage', 'creditText', 'copyrightNotice', 'creator'].some((k) => c.has(k))) {
        if (!c.has('contentUrl')) c.issue('warning', 'recommended-missing', ['contentUrl'], 'Image license metadata uses contentUrl to know which image it describes (url is less precise)');
        if (!c.has('license')) c.issue('info', 'recommended-missing', ['license'], 'license is needed for the Licensable badge');
      }
    },
  },
];

for (const r of RULES) r.lastVerified = LAST_VERIFIED;
export const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

/** Rules for a node in its context (reference contexts get none; component types are checked by their parent). */
export function rulesFor(node, { topLevel, parentProp }) {
  const t = typesOf(node);
  if (!t.length) return [];
  if (!topLevel && parentProp && REFERENCE_PROPS.has(parentProp)) return [];
  return RULES.filter((r) => (!r.topLevelOnly || topLevel) && r.match(t));
}

// ---------- generic per-node checks ----------
const URL_PROPS = ['url', 'image', 'logo', 'thumbnailUrl', 'contentUrl', 'embedUrl', 'acquireLicensePage', 'mainEntityOfPage'];
const DATE_PROPS = ['datePublished', 'dateModified', 'dateCreated', 'uploadDate', 'startDate', 'endDate', 'foundingDate', 'priceValidUntil', 'validFrom', 'validThrough', 'expires', 'previousStartDate'];

function genericChecks(node, nodePath, { issues, rules, page, typeLabel, downgrade }) {
  const requiredProps = new Set(rules.flatMap((r) => r.required || []).map((p) => p.split(/[ .(]/)[0]));
  const push = (severity, rule, rel, detail, source) => {
    const sev = downgrade && severity === 'error' ? 'warning' : severity;
    issues.push({ severity: sev, rule, type: typeLabel, path: jsonPath([...nodePath, ...rel]), detail, source: source || (rules[0] && rules[0].docUrl) || POLICY_URL });
  };
  for (const prop of URL_PROPS) {
    for (const { value, path } of values(node, prop)) {
      if (value && typeof value === 'object') {
        if (prop === 'mainEntityOfPage' || typesOf(value).length) {
          const inner = literal(value.url || value.contentUrl || (prop === 'mainEntityOfPage' ? value['@id'] : ''));
          if (typeof inner === 'string' && inner && !isAbsoluteUrl(inner) && !inner.startsWith('#')) push('warning', 'invalid-url', [...path, value.url ? 'url' : 'contentUrl'], `${prop} URL "${inner}" is not an absolute http(s) URL`);
        }
        continue;
      }
      if (typeof value !== 'string' || !value.trim()) continue;
      if (!isAbsoluteUrl(value)) push(requiredProps.has(prop) ? 'error' : 'warning', 'invalid-url', path, `${prop} "${value.slice(0, 120)}" is not an absolute http(s) URL`);
    }
  }
  for (const prop of DATE_PROPS) {
    for (const { value, path } of values(node, prop)) {
      if (value && typeof value === 'object') continue;
      const d = parseIsoDate(value);
      if (!d.ok && ['foundingDate', 'dissolutionDate', 'birthDate', 'deathDate'].includes(prop) && /^\d{4}(-\d{2})?$/.test(String(literal(value)).trim())) continue;
      if (!d.ok) push(requiredProps.has(prop) ? 'error' : 'warning', 'invalid-date', path, `${prop} "${String(value).slice(0, 60)}" is not an ISO 8601 date or date-time (e.g. 2026-10-02 or 2026-10-02T09:30:00+08:00)`);
      else if (page && page.now && ['datePublished', 'dateModified', 'uploadDate', 'dateCreated'].includes(prop) && d.time > page.now + 2 * 86400000) push('warning', 'date-in-future', path, `${prop} ${value} is in the future`);
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if ((k.startsWith('@') && k !== '@id') || ['target', 'urlTemplate', 'query-input', 'query'].includes(k)) continue;
    for (const item of [].concat(v)) {
      const s = literal(item);
      if (typeof s !== 'string') continue;
      const why = placeholderIn(s, page && page.host);
      if (why) push('warning', 'placeholder', [k], `${k} contains a ${why}: "${s.slice(0, 80)}"`, POLICY_URL);
    }
  }
}

function answerAbsent(text, page) {
  const plain = plainText(text);
  const key = compactKey(plain);
  if (!key || page.visibleKey.includes(key)) return false;
  const words = plain.split(/\s+/).filter(Boolean).length;
  if (words < 4 && key.length < 12) return !page.visibleKey.includes(key);
  const a = shingleSet(plain);
  if (!page.shingles) page.shingles = shingleSet(page.visibleText || '');
  let hit = 0;
  for (const x of a) if (page.shingles.has(x)) hit++;
  return a.size ? hit / a.size < 0.5 : false;
}

/**
 * Validate one parsed JSON-LD block. page = {url, host, visibleText, visibleKey, numbers, now} (visible fields
 * optional). resolve(id) returns a defined node for @id references (page first, then site). Returns issues.
 */
export function validateBlock(data, { page = {}, resolve, blockLabel = '', incoming } = {}) {
  const issues = [];
  const into = new Map(incoming || []);
  for (const r of idIndex([{ data }]).refs) {
    if (!r.parentProp) continue;
    if (!into.has(r.id)) into.set(r.id, new Set());
    into.get(r.id).add(r.parentProp);
  }
  const roots = Array.isArray(data) ? data : [data];
  roots.forEach((root, i) => {
    if (!root || typeof root !== 'object') return;
    const ctx = root['@context'];
    const rootPath = Array.isArray(data) ? [i] : [];
    if (ctx === undefined) issues.push({ severity: 'error', rule: 'context-missing', type: typesOf(root).join(',') || '', path: jsonPath(rootPath), detail: 'Missing "@context": "https://schema.org" (without it the block is not read as schema.org)', source: POLICY_URL });
    else if (!/schema\.org/i.test(JSON.stringify(ctx))) issues.push({ severity: 'warning', rule: 'context-not-schema-org', type: typesOf(root).join(',') || '', path: jsonPath([...rootPath, '@context']), detail: `@context ${JSON.stringify(ctx).slice(0, 80)} is not schema.org`, source: POLICY_URL });
  });
  walkJsonLd(data, (node, ctx) => {
    if (isReference(node)) return;
    const t = typesOf(node);
    const isWrapper = ctx.topLevel && !t.length && Array.isArray(node['@graph']);
    if (isWrapper) return;
    if (!t.length) {
      if (ctx.topLevel && Object.keys(node).some((k) => !k.startsWith('@'))) issues.push({ severity: 'warning', rule: 'type-missing', type: '', path: jsonPath(ctx.path), detail: 'Node has properties but no @type; it is ignored', source: POLICY_URL });
      return;
    }
    const reference = !ctx.topLevel && ctx.parentProp && REFERENCE_PROPS.has(ctx.parentProp);
    const status = statusFor(node);
    const downgrade = status.some((s) => s.downgrade);
    const rules = reference ? [] : rulesFor(node, ctx);
    const typeLabel = t.join(',');
    if (reference) {
      if (!present(node.name) && !node['@id'] && !present(node.url)) issues.push({ severity: 'warning', rule: 'reference-incomplete', type: typeLabel, path: jsonPath(ctx.path), detail: `${ctx.parentProp} (${typeLabel}) has neither name, url nor @id`, source: POLICY_URL });
    }
    genericChecks(node, ctx.path, { issues, rules, page, typeLabel, downgrade });
    for (const rule of rules) {
      const c = new Checker({ node, nodePath: ctx.path, rule, resolve, page, issues, topLevel: ctx.topLevel, parentProp: ctx.parentProp, downgrade: downgrade && rule.id !== 'BreadcrumbList', incoming: typeof node['@id'] === 'string' ? into.get(node['@id']) : null });
      rule.check(c);
    }
  });
  if (blockLabel) for (const i of issues) i.path = `${blockLabel} ${i.path}`;
  return issues;
}

/** Index of defined nodes ({@id} with properties) and references ({@id} only) in parsed blocks. */
export function idIndex(blocks) {
  const defined = new Map();
  const refs = [];
  (blocks || []).forEach((b, block) => {
    if (!b || b.error || !b.data) return;
    walkJsonLd(b.data, (node, ctx) => {
      const id = typeof node['@id'] === 'string' ? node['@id'].trim() : '';
      if (!id) return;
      if (isReference(node)) refs.push({ id, block, path: ctx.path, parentProp: ctx.parentProp, types: typesOf(node) });
      else {
        if (!defined.has(id)) defined.set(id, []);
        defined.get(id).push({ node, block, path: ctx.path, topLevel: ctx.topLevel, parentProp: ctx.parentProp, types: typesOf(node) });
      }
    });
  });
  return { defined, refs };
}

/** Rule metadata for reports: [{id, docUrl, docUpdated, lastVerified, required, recommended, oneOf}]. */
export function ruleCatalog() {
  return RULES.map((r) => ({ id: r.id, docUrl: r.docUrl, docUpdated: r.docUpdated, lastVerified: LAST_VERIFIED, required: r.required || [], recommended: r.recommended || [], oneOf: r.oneOf || [] }));
}
