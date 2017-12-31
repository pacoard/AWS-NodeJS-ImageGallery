#!/usr/bin/python

import os, requests, argparse, json

parser = argparse.ArgumentParser(description="Script that automates the upload of all the images in a folder to ITMO's MP3 server.")
# python large-scale-test.py --images-path 1
parser.add_argument('--images-path', '-ip', required=True, help="Path (relative or absolute) to the images for the test")

args = parser.parse_args()

if args.images_path[-1] != '/':
	args.images_path = args.images_path + '/'

print(args)
print('\n')

def execCommand(commandString):
	print('==========> Running command: ' + commandString + '\n')
	os.system(commandString)

JSON_OUTPUT = 'output.json'
def extractJSON():
	jsondict = {}
	with open(JSON_OUTPUT) as jsonfile:
		jsondict = json.load(jsonfile)
	os.remove(JSON_OUTPUT)
	return jsondict

execCommand('aws elb describe-load-balancers'
			+ ' --load-balancer-names itmo544-elb > ' + JSON_OUTPUT)

ELB_DNS = extractJSON()['LoadBalancerDescriptions'][0]['DNSName']

values = {'email': 'automated-test-email', 'phone': 'automated-test-phone'}

for filename in os.listdir(args.images_path):
	print('Uploading ' + filename)
	file = {'image': open(args.images_path + filename, 'rb')}
	r = requests.post('http://' + ELB_DNS + '/API/upload', files=file, data=values)