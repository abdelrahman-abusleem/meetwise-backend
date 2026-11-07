"""Synthetic formatting regressions; no audio, network or provider operations."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import s1_quality_report as reporter
from test_s1_quality_report import fixture


class QualityRenderTests(unittest.TestCase):
    def test_deterministic_complete_report(self):
        result = reporter.build_report(*fixture())
        text = reporter.render_markdown(result)
        self.assertEqual(text, reporter.render_markdown(result))
        for case in result['measurement']['cases']:
            self.assertIn('| '+case['id']+' |', text)
        for key in ['AR-EG','EN','MIX','overall']:
            self.assertIn('| '+key+' |', text)
        for key in ['manifestSha256','inputSha256','scorerSha256','reporterSha256']:
            self.assertIn(result[key], text)
        self.assertIn(result['measurement']['runtime'], text)
        self.assertIn(result['measurement']['unicode'], text)
        self.assertIn('Secondary macro', text)

    def test_no_lexical_or_private_path_output(self):
        text = reporter.render_markdown(reporter.build_report(*fixture()))
        for private in ['fictional','alpha','beta',str(Path(__file__).parent),'referenceSha256']:
            self.assertNotIn(private, text)

    def test_scoped_pending_and_proposed_states(self):
        text = reporter.render_markdown(reporter.build_report(*fixture()))
        for marker in ['S1 LIVE BLOCKED','Phase 3 NO-GO','PENDING_OWNER_FREEZE',
                       'PROPOSED_NOT_APPROVED','CALLER_REPORTED_NOT_INDEPENDENT_EVIDENCE',
                       'QUARANTINED_PENDING_OWNER','NOT_VERIFIED_BY_THIS_TOOL']:
            self.assertIn(marker, text)
        self.assertIn('No S1 acceptance', text)

    def test_conditional_failure_and_observation_failures_visible(self):
        manifest,payload=fixture()
        payload['cases'][3]['hypothesis']='fictional alpha other'
        payload['cases'][0]['observations']['stopMs']=15001
        payload['silence']['lexicalTokens']=1
        text=reporter.render_markdown(reporter.build_report(manifest,payload))
        self.assertIn('EXCEEDS_CONDITIONAL_MAXIMA',text)
        self.assertIn('stopAtMost15Seconds=NOT_MET',text)
        self.assertIn('silenceNoLexicalOutput=NOT_MET',text)
        self.assertIn('0/0/0/3',text)

    def test_default_json_and_markdown_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            paths=[Path(directory)/'manifest.json',Path(directory)/'input.json']
            for path,value in zip(paths,fixture()):
                path.write_text(json.dumps(value),encoding='utf8')
            for arguments in [[],['--format','json'],['--format','markdown']]:
                output=io.StringIO()
                with patch.object(sys,'argv',['report',*map(str,paths),*arguments]),contextlib.redirect_stdout(output):
                    self.assertEqual(reporter.main(),0)
                if arguments == ['--format','markdown']:
                    self.assertTrue(output.getvalue().startswith('# S1 quality measurement'))
                else:
                    self.assertFalse(json.loads(output.getvalue())['s1Pass'])

    def test_markdown_invalid_input_still_generic(self):
        with tempfile.TemporaryDirectory() as directory:
            paths=[Path(directory)/'manifest.json',Path(directory)/'private-secret.json']
            paths[0].write_text(json.dumps(fixture()[0]),encoding='utf8')
            paths[1].write_text('{"private":"DO_NOT_LEAK"}',encoding='utf8')
            output,error=io.StringIO(),io.StringIO()
            with patch.object(sys,'argv',['report',*map(str,paths),'--format','markdown']),contextlib.redirect_stdout(output),contextlib.redirect_stderr(error):
                self.assertEqual(reporter.main(),2)
            self.assertEqual(output.getvalue(),'')
            self.assertEqual(error.getvalue(),'REPORT_FAILED: invalid, incomplete or unreadable private input. Metrics=NOT_MEASURED; S1=BLOCKED.\n')

    def test_unicode_stays_in_scoring_not_lexical_rendering(self):
        import hashlib
        manifest,payload=fixture()
        for clip,case in zip(manifest['clips'],payload['cases']):
            case['reference']='أَهْلًا café 😀'
            case['hypothesis']='أَهْلًا cafe\u0301 😀'
            clip['referenceSha256']=hashlib.sha256(case['reference'].encode('utf8')).hexdigest()
        result=reporter.build_report(manifest,payload)
        self.assertEqual(result['measurement']['overall']['CER']['ratio'],0)
        text=reporter.render_markdown(result)
        for lexical in ['أَهْلًا','café','😀']:
            self.assertNotIn(lexical,text)
        self.assertIn('0.000000%',text)

    def test_missing_case_does_not_produce_partial_markdown(self):
        manifest,payload=fixture()
        payload['cases'].pop()
        with tempfile.TemporaryDirectory() as directory:
            paths=[Path(directory)/'manifest.json',Path(directory)/'input.json']
            for path,value in zip(paths,[manifest,payload]):
                path.write_text(json.dumps(value),encoding='utf8')
            output,error=io.StringIO(),io.StringIO()
            with patch.object(sys,'argv',['report',*map(str,paths),'--format','markdown']),contextlib.redirect_stdout(output),contextlib.redirect_stderr(error):
                self.assertEqual(reporter.main(),2)
            self.assertEqual(output.getvalue(),'')
            self.assertIn('Metrics=NOT_MEASURED; S1=BLOCKED',error.getvalue())


if __name__=='__main__':
    unittest.main()
