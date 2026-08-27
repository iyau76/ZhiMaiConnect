declare module "solarlunar" {
  interface SolarLunarResult {
    cYear: number;
    cMonth: number;
    cDay: number;
    isLeap: boolean;
  }

  const solarLunar: {
    lunar2solar(
      year: number,
      month: number,
      day: number,
      isLeapMonth?: boolean,
    ): SolarLunarResult | -1;
  };

  export default solarLunar;
}
