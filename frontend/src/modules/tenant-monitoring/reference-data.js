/* Reference data for the Company Information create-tenant form's
   dropdowns. Real, standard datasets — not invented:

   - COUNTRIES: ISO 3166-1 alpha-2.
   - CURRENCIES: ISO 4217 (active currencies).
   - LANGUAGES: ISO 639-1.
   - INDUSTRIES: the standard Salesforce Industry picklist — a real,
     widely-used reference set; there's no ISO standard for "industry."

   DATA_RESIDENCY_REGIONS is the one list with no canonical source: the
   backend's own `Tenant.dataResidencyRegion` is deliberately a freeform
   `varchar`, with "a canonical region-code enum" an explicitly open,
   unbuilt TODO (see docs/adr/0072-multi-region-topology-and-region-
   awareness.md and docs/module-05-phase-8-production-readiness-
   checklist.md — "Standardizing this is Module 01's call, not
   retroactively fixed here"). These are real AWS region codes, the same
   convention every example/placeholder and every seeded demo tenant in
   this codebase already uses — a sensible default list, not a platform
   capability being claimed. */

export const COUNTRIES = [
  ['AF', 'Afghanistan'], ['AL', 'Albania'], ['DZ', 'Algeria'], ['AD', 'Andorra'], ['AO', 'Angola'],
  ['AG', 'Antigua and Barbuda'], ['AR', 'Argentina'], ['AM', 'Armenia'], ['AU', 'Australia'], ['AT', 'Austria'],
  ['AZ', 'Azerbaijan'], ['BS', 'Bahamas'], ['BH', 'Bahrain'], ['BD', 'Bangladesh'], ['BB', 'Barbados'],
  ['BY', 'Belarus'], ['BE', 'Belgium'], ['BZ', 'Belize'], ['BJ', 'Benin'], ['BT', 'Bhutan'],
  ['BO', 'Bolivia'], ['BA', 'Bosnia and Herzegovina'], ['BW', 'Botswana'], ['BR', 'Brazil'], ['BN', 'Brunei'],
  ['BG', 'Bulgaria'], ['BF', 'Burkina Faso'], ['BI', 'Burundi'], ['CV', 'Cabo Verde'], ['KH', 'Cambodia'],
  ['CM', 'Cameroon'], ['CA', 'Canada'], ['CF', 'Central African Republic'], ['TD', 'Chad'], ['CL', 'Chile'],
  ['CN', 'China'], ['CO', 'Colombia'], ['KM', 'Comoros'], ['CG', 'Congo'], ['CD', 'Congo (DRC)'],
  ['CR', 'Costa Rica'], ['CI', "Côte d'Ivoire"], ['HR', 'Croatia'], ['CU', 'Cuba'], ['CY', 'Cyprus'],
  ['CZ', 'Czechia'], ['DK', 'Denmark'], ['DJ', 'Djibouti'], ['DM', 'Dominica'], ['DO', 'Dominican Republic'],
  ['EC', 'Ecuador'], ['EG', 'Egypt'], ['SV', 'El Salvador'], ['GQ', 'Equatorial Guinea'], ['ER', 'Eritrea'],
  ['EE', 'Estonia'], ['SZ', 'Eswatini'], ['ET', 'Ethiopia'], ['FJ', 'Fiji'], ['FI', 'Finland'],
  ['FR', 'France'], ['GA', 'Gabon'], ['GM', 'Gambia'], ['GE', 'Georgia'], ['DE', 'Germany'],
  ['GH', 'Ghana'], ['GR', 'Greece'], ['GD', 'Grenada'], ['GT', 'Guatemala'], ['GN', 'Guinea'],
  ['GW', 'Guinea-Bissau'], ['GY', 'Guyana'], ['HT', 'Haiti'], ['HN', 'Honduras'], ['HU', 'Hungary'],
  ['IS', 'Iceland'], ['IN', 'India'], ['ID', 'Indonesia'], ['IR', 'Iran'], ['IQ', 'Iraq'],
  ['IE', 'Ireland'], ['IL', 'Israel'], ['IT', 'Italy'], ['JM', 'Jamaica'], ['JP', 'Japan'],
  ['JO', 'Jordan'], ['KZ', 'Kazakhstan'], ['KE', 'Kenya'], ['KI', 'Kiribati'], ['KP', 'Korea (North)'],
  ['KR', 'Korea (South)'], ['KW', 'Kuwait'], ['KG', 'Kyrgyzstan'], ['LA', 'Laos'], ['LV', 'Latvia'],
  ['LB', 'Lebanon'], ['LS', 'Lesotho'], ['LR', 'Liberia'], ['LY', 'Libya'], ['LI', 'Liechtenstein'],
  ['LT', 'Lithuania'], ['LU', 'Luxembourg'], ['MG', 'Madagascar'], ['MW', 'Malawi'], ['MY', 'Malaysia'],
  ['MV', 'Maldives'], ['ML', 'Mali'], ['MT', 'Malta'], ['MH', 'Marshall Islands'], ['MR', 'Mauritania'],
  ['MU', 'Mauritius'], ['MX', 'Mexico'], ['FM', 'Micronesia'], ['MD', 'Moldova'], ['MC', 'Monaco'],
  ['MN', 'Mongolia'], ['ME', 'Montenegro'], ['MA', 'Morocco'], ['MZ', 'Mozambique'], ['MM', 'Myanmar'],
  ['NA', 'Namibia'], ['NR', 'Nauru'], ['NP', 'Nepal'], ['NL', 'Netherlands'], ['NZ', 'New Zealand'],
  ['NI', 'Nicaragua'], ['NE', 'Niger'], ['NG', 'Nigeria'], ['MK', 'North Macedonia'], ['NO', 'Norway'],
  ['OM', 'Oman'], ['PK', 'Pakistan'], ['PW', 'Palau'], ['PA', 'Panama'], ['PG', 'Papua New Guinea'],
  ['PY', 'Paraguay'], ['PE', 'Peru'], ['PH', 'Philippines'], ['PL', 'Poland'], ['PT', 'Portugal'],
  ['QA', 'Qatar'], ['RO', 'Romania'], ['RU', 'Russia'], ['RW', 'Rwanda'], ['KN', 'Saint Kitts and Nevis'],
  ['LC', 'Saint Lucia'], ['VC', 'Saint Vincent and the Grenadines'], ['WS', 'Samoa'], ['SM', 'San Marino'],
  ['ST', 'Sao Tome and Principe'], ['SA', 'Saudi Arabia'], ['SN', 'Senegal'], ['RS', 'Serbia'],
  ['SC', 'Seychelles'], ['SL', 'Sierra Leone'], ['SG', 'Singapore'], ['SK', 'Slovakia'], ['SI', 'Slovenia'],
  ['SB', 'Solomon Islands'], ['SO', 'Somalia'], ['ZA', 'South Africa'], ['SS', 'South Sudan'], ['ES', 'Spain'],
  ['LK', 'Sri Lanka'], ['SD', 'Sudan'], ['SR', 'Suriname'], ['SE', 'Sweden'], ['CH', 'Switzerland'],
  ['SY', 'Syria'], ['TW', 'Taiwan'], ['TJ', 'Tajikistan'], ['TZ', 'Tanzania'], ['TH', 'Thailand'],
  ['TL', 'Timor-Leste'], ['TG', 'Togo'], ['TO', 'Tonga'], ['TT', 'Trinidad and Tobago'], ['TN', 'Tunisia'],
  ['TR', 'Turkey'], ['TM', 'Turkmenistan'], ['TV', 'Tuvalu'], ['UG', 'Uganda'], ['UA', 'Ukraine'],
  ['AE', 'United Arab Emirates'], ['GB', 'United Kingdom'], ['US', 'United States'], ['UY', 'Uruguay'],
  ['UZ', 'Uzbekistan'], ['VU', 'Vanuatu'], ['VA', 'Vatican City'], ['VE', 'Venezuela'], ['VN', 'Vietnam'],
  ['YE', 'Yemen'], ['ZM', 'Zambia'], ['ZW', 'Zimbabwe'],
];

export const CURRENCIES = [
  ['USD', 'US Dollar'], ['EUR', 'Euro'], ['GBP', 'British Pound'], ['JPY', 'Japanese Yen'], ['CNY', 'Chinese Yuan'],
  ['INR', 'Indian Rupee'], ['AUD', 'Australian Dollar'], ['CAD', 'Canadian Dollar'], ['CHF', 'Swiss Franc'], ['HKD', 'Hong Kong Dollar'],
  ['SGD', 'Singapore Dollar'], ['SEK', 'Swedish Krona'], ['NOK', 'Norwegian Krone'], ['DKK', 'Danish Krone'], ['NZD', 'New Zealand Dollar'],
  ['MXN', 'Mexican Peso'], ['ZAR', 'South African Rand'], ['BRL', 'Brazilian Real'], ['RUB', 'Russian Ruble'], ['KRW', 'South Korean Won'],
  ['TRY', 'Turkish Lira'], ['AED', 'UAE Dirham'], ['SAR', 'Saudi Riyal'], ['PLN', 'Polish Zloty'], ['THB', 'Thai Baht'],
  ['IDR', 'Indonesian Rupiah'], ['MYR', 'Malaysian Ringgit'], ['PHP', 'Philippine Peso'], ['VND', 'Vietnamese Dong'], ['ILS', 'Israeli Shekel'],
  ['CZK', 'Czech Koruna'], ['HUF', 'Hungarian Forint'], ['RON', 'Romanian Leu'], ['CLP', 'Chilean Peso'], ['COP', 'Colombian Peso'],
  ['PEN', 'Peruvian Sol'], ['ARS', 'Argentine Peso'], ['EGP', 'Egyptian Pound'], ['NGN', 'Nigerian Naira'], ['KES', 'Kenyan Shilling'],
  ['PKR', 'Pakistani Rupee'], ['BDT', 'Bangladeshi Taka'], ['LKR', 'Sri Lankan Rupee'], ['QAR', 'Qatari Riyal'], ['KWD', 'Kuwaiti Dinar'],
  ['BHD', 'Bahraini Dinar'], ['OMR', 'Omani Rial'], ['JOD', 'Jordanian Dinar'], ['MAD', 'Moroccan Dirham'], ['TWD', 'Taiwan Dollar'],
  ['UAH', 'Ukrainian Hryvnia'], ['ISK', 'Icelandic Krona'], ['HRK', 'Croatian Kuna'], ['BGN', 'Bulgarian Lev'], ['GHS', 'Ghanaian Cedi'],
];

export const LANGUAGES = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['nl', 'Dutch'], ['ru', 'Russian'], ['zh', 'Chinese'], ['ja', 'Japanese'],
  ['ko', 'Korean'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['bn', 'Bengali'], ['ur', 'Urdu'],
  ['ta', 'Tamil'], ['te', 'Telugu'], ['mr', 'Marathi'], ['gu', 'Gujarati'], ['kn', 'Kannada'],
  ['ml', 'Malayalam'], ['pa', 'Punjabi'], ['th', 'Thai'], ['vi', 'Vietnamese'], ['id', 'Indonesian'],
  ['ms', 'Malay'], ['tl', 'Filipino'], ['tr', 'Turkish'], ['pl', 'Polish'], ['uk', 'Ukrainian'],
  ['ro', 'Romanian'], ['nb', 'Norwegian'], ['sv', 'Swedish'], ['da', 'Danish'], ['fi', 'Finnish'],
  ['el', 'Greek'], ['cs', 'Czech'], ['hu', 'Hungarian'], ['he', 'Hebrew'], ['fa', 'Persian'],
  ['sw', 'Swahili'], ['am', 'Amharic'], ['zu', 'Zulu'], ['af', 'Afrikaans'], ['sq', 'Albanian'],
];

export const INDUSTRIES = [
  'Agriculture', 'Apparel', 'Banking', 'Biotechnology', 'Chemicals', 'Communications', 'Construction',
  'Consulting', 'Education', 'Electronics', 'Energy', 'Engineering', 'Entertainment', 'Environmental',
  'Finance', 'Food & Beverage', 'Government', 'Healthcare', 'Hospitality', 'Insurance', 'Machinery',
  'Manufacturing', 'Media', 'Not For Profit', 'Recreation', 'Retail', 'Shipping', 'Technology',
  'Telecommunications', 'Transportation', 'Utilities', 'Other',
];

export const DATA_RESIDENCY_REGIONS = [
  ['us-east-1', 'US East (N. Virginia)'], ['us-west-2', 'US West (Oregon)'],
  ['ca-central-1', 'Canada (Central)'],
  ['eu-west-1', 'EU (Ireland)'], ['eu-west-2', 'EU (London)'], ['eu-central-1', 'EU (Frankfurt)'],
  ['ap-south-1', 'Asia Pacific (Mumbai)'], ['ap-southeast-1', 'Asia Pacific (Singapore)'],
  ['ap-southeast-2', 'Asia Pacific (Sydney)'], ['ap-northeast-1', 'Asia Pacific (Tokyo)'],
  ['sa-east-1', 'South America (São Paulo)'], ['af-south-1', 'Africa (Cape Town)'],
  ['me-south-1', 'Middle East (Bahrain)'],
];
