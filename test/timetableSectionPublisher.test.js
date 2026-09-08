const test = require('node:test');
const assert = require('node:assert/strict');
const { selectSectionWinners } = require('../lib/timetableSectionPublisher');
const { groupSectionReviews, compareSectionCopies } = require('../lib/timetableSectionReview');

function record({ id=1, catalogue='004901', number='004901', time='06:00', date='2026-09-01', days=['monday'], override=false } = {}) {
  return { sourceId: id, sectionId: id, sectionVersionId: id, versionId: id, sourceKey: number, catalogueKey: catalogue, override,
    extraction: { schema_version:1, operator:'GABS',source_key:number,publication_scope:'service_days',effective_date:date,
      routes:[{ code:number.slice(0,4),name:'A - B',directions:[{code:number.slice(4),name:'A - B',effective_date:date,
        services:[{label:'Service',service_days:days,footnotes:[],trips:[{footnote_markers:[],service_days:days,
          times:[{sequence:0,stop_name:'A',time,raw_time:time,stop_time_type:'scheduled'}]}]}]}]}] } };
}

test('own-route copy outranks a newer mixed copy', () => {
  const winners=selectSectionWinners([record(),record({id:2,catalogue:'009901',date:'2026-09-02',time:'07:00'})]);
  assert.equal([...winners.values()][0].sectionVersionId,1);
});
test('a section can never publish a foreign route or a sibling direction', () => {
  const wrongRoute = record();
  wrongRoute.extraction.routes[0].code = '0050';
  assert.throws(() => selectSectionWinners([wrongRoute]), /only the route and direction/);
  const sibling = record();
  sibling.extraction.routes[0].directions.push({...sibling.extraction.routes[0].directions[0], code:'02'});
  assert.throws(() => selectSectionWinners([sibling]), /only the route and direction/);
});
test('equal-date conflicts need explicit selection; identical copies yield one trip', () => {
  assert.throws(()=>selectSectionWinners([record(),record({id:2,time:'07:00'})]),/Conflicting copies/);
  const identical=selectSectionWinners([record(),record({id:2})]);
  assert.equal(identical.size,1);
  assert.equal([...identical.values()][0].trips.length,1);
  const chosen=selectSectionWinners([record(),record({id:2,time:'07:00',override:true})]);
  assert.equal([...chosen.values()][0].sectionVersionId,2);
});
test('regular and public holiday copies coexist; future revisions are excluded', () => {
  assert.equal(selectSectionWinners([record(),record({id:2,days:['public_holiday']})]).size,2);
  assert.equal(selectSectionWinners([record({date:'2099-01-01'})]).size,0);
});
test('duplicate pending copies share one logical review alert', () => {
  const rows=[1,2].map(id=>({id,timetable_number:'004901',catalogue_key:'004901',pending_version_id:id,
    content_sha256:'a',status:'changed_review_required',extraction:record().extraction}));
  const groups=groupSectionReviews(rows);
  assert.equal(groups.length,1);
  assert.equal(groups[0].change_alert_count,1);
  assert.equal(groups[0].conflicting_copies,false);
});

test('review source preference honours the recorded revision override', () => {
  const rows = [record(), record({id:2,catalogue:'009901',override:true,time:'07:00'})].map(r => ({
    id:r.sectionId, version_id:r.sectionVersionId, timetable_number:r.sourceKey,
    catalogue_key:r.catalogueKey, extraction:r.extraction, source_override:r.override, status:'verified',
  }));
  const [group] = groupSectionReviews(rows);
  assert.equal(group.preferred_section_id, 2);
  assert.equal(group.conflicting_copies, true);
  rows[1].source_override = false;
  assert.equal(groupSectionReviews(rows)[0].preferred_section_id, 1);
});

test('copy comparisons identify changed cells and reject unrelated timetable numbers', () => {
  const changes = compareSectionCopies(record().extraction, record({time:'07:00'}).extraction);
  assert.equal(changes.change_count, 2);
  assert.equal(changes.changes[0].before, '06:00');
  assert.equal(changes.changes[0].after, '07:00');
  assert.throws(() => compareSectionCopies(record().extraction, record({number:'005001'}).extraction), /same timetable/);
});
