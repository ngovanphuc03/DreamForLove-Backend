const { calculatePeriodStatus, evaluateFIGOHealth } = require('../src/controllers/period.controller');

console.log('--- RUNNING FLO-GRADE & FIGO MEDICAL TESTS ---');

function assert(condition, message) {
    if (!condition) {
        console.error('❌ FAILED:', message);
        process.exit(1);
    } else {
        console.log('✅ PASSED:', message);
    }
}

function localYMD(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// 1. Standard 28-day cycle test
{
    const today = new Date();
    const statusDay1 = calculatePeriodStatus(localYMD(today), 28, 5);
    assert(statusDay1.currentCycleDay === 1, 'Day 1 currentCycleDay should be 1');
    assert(statusDay1.phase === 'menstrual', 'Day 1 phase should be menstrual');
    assert(statusDay1.fertility === 'very_low', 'Day 1 fertility should be very_low');
    assert(statusDay1.ovulationDay === 14, '28-day cycle ovulation day should be 14');
}

// 2. 32-day cycle: Medical constant check (Luteal phase is 14 days, so Ovulation is 32 - 14 = 18)
{
    const thirtyTwoDayStatus = calculatePeriodStatus(localYMD(new Date()), 32, 5);
    assert(thirtyTwoDayStatus.ovulationDay === 18, `32-day cycle ovulation day must be 18 (got ${thirtyTwoDayStatus.ovulationDay})`);
    assert(thirtyTwoDayStatus.fertileWindowStart === 13, `32-day fertile window start must be 13 (got ${thirtyTwoDayStatus.fertileWindowStart})`);
    assert(thirtyTwoDayStatus.fertileWindowEnd === 19, `32-day fertile window end must be 19 (got ${thirtyTwoDayStatus.fertileWindowEnd})`);
}

// 3. 35-day cycle: Ovulation is 35 - 14 = 21
{
    const thirtyFiveDayStatus = calculatePeriodStatus(localYMD(new Date()), 35, 5);
    assert(thirtyFiveDayStatus.ovulationDay === 21, `35-day cycle ovulation day must be 21 (got ${thirtyFiveDayStatus.ovulationDay})`);
}

// 4. Overdue period test (e.g. last period was 35 days ago on a 28-day cycle)
{
    const overdueDate = new Date();
    overdueDate.setDate(overdueDate.getDate() - 35);
    const overdueStatus = calculatePeriodStatus(localYMD(overdueDate), 28, 5);
    assert(overdueStatus.phase === 'late', 'Overdue period phase must be late');
    assert(overdueStatus.daysLate === 7, `35 days on 28-day cycle must be 7 days late (got ${overdueStatus.daysLate})`);
    assert(overdueStatus.currentCycleDay === 36, 'Overdue cycle day should continue progressing without modulo wrap');
}

// 5. Ovulation day peak fertility test (13 days ago on a 28-day cycle => today is day 14)
{
    const ovDate = new Date();
    ovDate.setDate(ovDate.getDate() - 13);
    const ovStatus = calculatePeriodStatus(localYMD(ovDate), 28, 5);
    assert(ovStatus.currentCycleDay === 14, 'Should be cycle day 14');
    assert(ovStatus.isOvulationToday === true, 'Should be ovulation today');
    assert(ovStatus.fertility === 'peak', 'Fertility should be peak on ovulation day');
    assert(ovStatus.fertilityChancePercent === 30, 'Fertility chance should be 30% on peak day');
}

// 6. FIGO 2018: Normal healthy cycle assessment (28 days, 5 days flow)
{
    const assessment = evaluateFIGOHealth(28, 5, 'regular', []);
    assert(assessment.status === 'healthy', 'Normal cycle must have healthy FIGO status');
    assert(assessment.riskFlags.length === 0, 'Normal cycle must have 0 risk flags');
}

// 7. FIGO 2018: Polymenorrhea detection (< 24 days)
{
    const assessment = evaluateFIGOHealth(22, 5, 'regular', []);
    assert(assessment.status === 'needs_attention', 'Cycle < 24 days must need attention');
    assert(assessment.riskFlags.some(f => f.type === 'polymenorrhea'), 'Should flag polymenorrhea for 22d cycle');
}

// 8. FIGO 2018: Oligomenorrhea detection (> 38 days)
{
    const assessment = evaluateFIGOHealth(40, 5, 'regular', []);
    assert(assessment.status === 'needs_attention', 'Cycle > 38 days must need attention');
    assert(assessment.riskFlags.some(f => f.type === 'oligomenorrhea'), 'Should flag oligomenorrhea for 40d cycle');
}

// 9. FIGO 2018: Menorrhagia / Rong kinh detection (> 8 days flow)
{
    const assessment = evaluateFIGOHealth(28, 9, 'regular', []);
    assert(assessment.status === 'alert', 'Flow > 8 days must trigger alert');
    assert(assessment.riskFlags.some(f => f.type === 'menorrhagia'), 'Should flag menorrhagia for 9-day flow');
}

console.log('--- ALL 9 BIORHYTHM & FIGO MEDICAL TESTS PASSED PERFECTLY! ---');
